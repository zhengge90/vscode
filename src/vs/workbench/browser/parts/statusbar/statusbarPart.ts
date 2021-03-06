/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/statusbarpart';
import * as nls from 'vs/nls';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { dispose, IDisposable, toDisposable, combinedDisposable } from 'vs/base/common/lifecycle';
import { OcticonLabel } from 'vs/base/browser/ui/octiconLabel/octiconLabel';
import { Registry } from 'vs/platform/registry/common/platform';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Part } from 'vs/workbench/browser/part';
import { IStatusbarRegistry, Extensions, IStatusbarItem } from 'vs/workbench/browser/parts/statusbar/statusbar';
import { IInstantiationService, ServiceIdentifier } from 'vs/platform/instantiation/common/instantiation';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { StatusbarAlignment, IStatusbarService, IStatusbarEntry } from 'vs/platform/statusbar/common/statusbar';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Action } from 'vs/base/common/actions';
import { IThemeService, registerThemingParticipant, ITheme, ICssStyleCollector, ThemeColor } from 'vs/platform/theme/common/themeService';
import { STATUS_BAR_BACKGROUND, STATUS_BAR_FOREGROUND, STATUS_BAR_NO_FOLDER_BACKGROUND, STATUS_BAR_ITEM_HOVER_BACKGROUND, STATUS_BAR_ITEM_ACTIVE_BACKGROUND, STATUS_BAR_PROMINENT_ITEM_BACKGROUND, STATUS_BAR_PROMINENT_ITEM_HOVER_BACKGROUND, STATUS_BAR_BORDER, STATUS_BAR_NO_FOLDER_FOREGROUND, STATUS_BAR_NO_FOLDER_BORDER } from 'vs/workbench/common/theme';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { contrastBorder } from 'vs/platform/theme/common/colorRegistry';
import { isThemeColor } from 'vs/editor/common/editorCommon';
import { Color } from 'vs/base/common/color';
import { addClass, EventHelper, createStyleSheet, addDisposableListener } from 'vs/base/browser/dom';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { Parts, IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';

export class StatusbarPart extends Part implements IStatusbarService {

	_serviceBrand: ServiceIdentifier<any>;

	private static readonly PRIORITY_PROP = 'statusbar-entry-priority';
	private static readonly ALIGNMENT_PROP = 'statusbar-entry-alignment';

	//#region IView

	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 22;
	readonly maximumHeight: number = 22;

	//#endregion

	private statusMsgDispose: IDisposable;
	private styleElement: HTMLStyleElement;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService
	) {
		super(Parts.STATUSBAR_PART, { hasTitle: false }, themeService, storageService, layoutService);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.contextService.onDidChangeWorkbenchState(() => this.updateStyles()));
	}

	addEntry(entry: IStatusbarEntry, alignment: StatusbarAlignment, priority: number = 0): IDisposable {

		// Render entry in status bar
		const el = this.doCreateStatusItem(alignment, priority, entry.showBeak ? 'has-beak' : undefined);
		const item = this.instantiationService.createInstance(StatusBarEntryItem, entry);
		const toDispose = item.render(el);

		// Insert according to priority
		const container = this.element;
		const neighbours = this.getEntries(alignment);
		let inserted = false;
		for (const neighbour of neighbours) {
			const nPriority = Number(neighbour.getAttribute(StatusbarPart.PRIORITY_PROP));
			if (
				alignment === StatusbarAlignment.LEFT && nPriority < priority ||
				alignment === StatusbarAlignment.RIGHT && nPriority > priority
			) {
				container.insertBefore(el, neighbour);
				inserted = true;
				break;
			}
		}

		if (!inserted) {
			container.appendChild(el);
		}

		return toDisposable(() => {
			el.remove();

			if (toDispose) {
				toDispose.dispose();
			}
		});
	}

	private getEntries(alignment: StatusbarAlignment): HTMLElement[] {
		const entries: HTMLElement[] = [];

		const container = this.element;
		const children = container.children;
		for (let i = 0; i < children.length; i++) {
			const childElement = <HTMLElement>children.item(i);
			if (Number(childElement.getAttribute(StatusbarPart.ALIGNMENT_PROP)) === alignment) {
				entries.push(childElement);
			}
		}

		return entries;
	}

	createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;

		// Fill in initial items that were contributed from the registry
		const registry = Registry.as<IStatusbarRegistry>(Extensions.Statusbar);

		const descriptors = registry.items.slice().sort((a, b) => {
			if (a.alignment === b.alignment) {
				if (a.alignment === StatusbarAlignment.LEFT) {
					return b.priority - a.priority;
				} else {
					return a.priority - b.priority;
				}
			} else if (a.alignment === StatusbarAlignment.LEFT) {
				return 1;
			} else if (a.alignment === StatusbarAlignment.RIGHT) {
				return -1;
			} else {
				return 0;
			}
		});

		for (const descriptor of descriptors) {
			const item = this.instantiationService.createInstance(descriptor.syncDescriptor);
			const el = this.doCreateStatusItem(descriptor.alignment, descriptor.priority);

			this._register(item.render(el));
			this.element.appendChild(el);
		}

		return this.element;
	}

	updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();

		// Background colors
		const backgroundColor = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_BACKGROUND : STATUS_BAR_NO_FOLDER_BACKGROUND);
		container.style.backgroundColor = backgroundColor;
		container.style.color = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_FOREGROUND : STATUS_BAR_NO_FOLDER_FOREGROUND);

		// Border color
		const borderColor = this.getColor(this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY ? STATUS_BAR_BORDER : STATUS_BAR_NO_FOLDER_BORDER) || this.getColor(contrastBorder);
		container.style.borderTopWidth = borderColor ? '1px' : null;
		container.style.borderTopStyle = borderColor ? 'solid' : null;
		container.style.borderTopColor = borderColor;

		// Notification Beak
		if (!this.styleElement) {
			this.styleElement = createStyleSheet(container);
		}

		this.styleElement.innerHTML = `.monaco-workbench .part.statusbar > .statusbar-item.has-beak:before { border-bottom-color: ${backgroundColor}; }`;
	}

	private doCreateStatusItem(alignment: StatusbarAlignment, priority: number = 0, extraClass?: string): HTMLElement {
		const el = document.createElement('div');
		addClass(el, 'statusbar-item');
		if (extraClass) {
			addClass(el, extraClass);
		}

		if (alignment === StatusbarAlignment.RIGHT) {
			addClass(el, 'right');
		} else {
			addClass(el, 'left');
		}

		el.setAttribute(StatusbarPart.PRIORITY_PROP, String(priority));
		el.setAttribute(StatusbarPart.ALIGNMENT_PROP, String(alignment));

		return el;
	}

	setStatusMessage(message: string, autoDisposeAfter: number = -1, delayBy: number = 0): IDisposable {
		if (this.statusMsgDispose) {
			this.statusMsgDispose.dispose(); // dismiss any previous
		}

		// Create new
		let statusDispose: IDisposable;
		let showHandle: any = setTimeout(() => {
			statusDispose = this.addEntry({ text: message }, StatusbarAlignment.LEFT, -Number.MAX_VALUE /* far right on left hand side */);
			showHandle = null;
		}, delayBy);
		let hideHandle: any;

		// Dispose function takes care of timeouts and actual entry
		const dispose = {
			dispose: () => {
				if (showHandle) {
					clearTimeout(showHandle);
				}

				if (hideHandle) {
					clearTimeout(hideHandle);
				}

				if (statusDispose) {
					statusDispose.dispose();
				}
			}
		};
		this.statusMsgDispose = dispose;

		if (typeof autoDisposeAfter === 'number' && autoDisposeAfter > 0) {
			hideHandle = setTimeout(() => dispose.dispose(), autoDisposeAfter);
		}

		return dispose;
	}

	layout(width: number, height: number): void {
		super.layoutContents(width, height);
	}

	toJSON(): object {
		return {
			type: Parts.STATUSBAR_PART
		};
	}
}

let manageExtensionAction: ManageExtensionAction;
class StatusBarEntryItem implements IStatusbarItem {

	constructor(
		private entry: IStatusbarEntry,
		@ICommandService private readonly commandService: ICommandService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IEditorService private readonly editorService: IEditorService,
		@IThemeService private readonly themeService: IThemeService
	) {
		this.entry = entry;

		if (!manageExtensionAction) {
			manageExtensionAction = this.instantiationService.createInstance(ManageExtensionAction);
		}
	}

	render(el: HTMLElement): IDisposable {
		let toDispose: IDisposable[] = [];
		addClass(el, 'statusbar-entry');

		// Text Container
		let textContainer: HTMLElement;
		if (this.entry.command) {
			textContainer = document.createElement('a');

			toDispose.push(addDisposableListener(textContainer, 'click', () => this.executeCommand(this.entry.command!, this.entry.arguments)));
		} else {
			textContainer = document.createElement('span');
		}

		// Label
		new OcticonLabel(textContainer).text = this.entry.text;

		// Tooltip
		if (this.entry.tooltip) {
			textContainer.title = this.entry.tooltip;
		}

		// Color (only applies to text container)
		toDispose.push(this.applyColor(textContainer, this.entry.color));

		// Background Color (applies to parent element to fully fill container)
		if (this.entry.backgroundColor) {
			toDispose.push(this.applyColor(el, this.entry.backgroundColor, true));
			addClass(el, 'has-background-color');
		}

		// Context Menu
		if (this.entry.extensionId) {
			toDispose.push(addDisposableListener(textContainer, 'contextmenu', e => {
				EventHelper.stop(e, true);

				this.contextMenuService.showContextMenu({
					getAnchor: () => el,
					getActionsContext: () => this.entry.extensionId!.value,
					getActions: () => [manageExtensionAction]
				});
			}));
		}

		el.appendChild(textContainer);

		return {
			dispose: () => {
				toDispose = dispose(toDispose);
			}
		};
	}

	private applyColor(container: HTMLElement, color: string | ThemeColor | undefined, isBackground?: boolean): IDisposable {
		const disposable: IDisposable[] = [];

		if (color) {
			if (isThemeColor(color)) {
				const colorId = color.id;
				color = (this.themeService.getTheme().getColor(colorId) || Color.transparent).toString();
				disposable.push(this.themeService.onThemeChange(theme => {
					const colorValue = (theme.getColor(colorId) || Color.transparent).toString();
					isBackground ? container.style.backgroundColor = colorValue : container.style.color = colorValue;
				}));
			}
			isBackground ? container.style.backgroundColor = color : container.style.color = color;
		}

		return combinedDisposable(disposable);
	}

	private executeCommand(id: string, args?: any[]) {
		args = args || [];

		// Maintain old behaviour of always focusing the editor here
		const activeTextEditorWidget = this.editorService.activeTextEditorWidget;
		if (activeTextEditorWidget) {
			activeTextEditorWidget.focus();
		}

		/* __GDPR__
			"workbenchActionExecuted" : {
				"id" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
				"from": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
			}
		*/
		this.telemetryService.publicLog('workbenchActionExecuted', { id, from: 'status bar' });
		this.commandService.executeCommand(id, ...args).then(undefined, err => this.notificationService.error(toErrorMessage(err)));
	}
}

class ManageExtensionAction extends Action {

	constructor(
		@ICommandService private readonly commandService: ICommandService
	) {
		super('statusbar.manage.extension', nls.localize('manageExtension', "Manage Extension"));
	}

	run(extensionId: string): Promise<any> {
		return this.commandService.executeCommand('_extensions.manage', extensionId);
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {
	const statusBarItemHoverBackground = theme.getColor(STATUS_BAR_ITEM_HOVER_BACKGROUND);
	if (statusBarItemHoverBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item a:hover { background-color: ${statusBarItemHoverBackground}; }`);
	}

	const statusBarItemActiveBackground = theme.getColor(STATUS_BAR_ITEM_ACTIVE_BACKGROUND);
	if (statusBarItemActiveBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item a:active { background-color: ${statusBarItemActiveBackground}; }`);
	}

	const statusBarProminentItemBackground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_BACKGROUND);
	if (statusBarProminentItemBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item .status-bar-info { background-color: ${statusBarProminentItemBackground}; }`);
	}

	const statusBarProminentItemHoverBackground = theme.getColor(STATUS_BAR_PROMINENT_ITEM_HOVER_BACKGROUND);
	if (statusBarProminentItemHoverBackground) {
		collector.addRule(`.monaco-workbench .part.statusbar > .statusbar-item a.status-bar-info:hover { background-color: ${statusBarProminentItemHoverBackground}; }`);
	}
});

registerSingleton(IStatusbarService, StatusbarPart);