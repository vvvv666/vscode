/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { addStandardDisposableListener, EventType, addDisposableListener, h, append } from 'vs/base/browser/dom';
import { FastDomNode, createFastDomNode } from 'vs/base/browser/fastDomNode';
import { IMouseWheelEvent } from 'vs/base/browser/mouseEvent';
import { IBoundarySashes, ISashEvent, Orientation, Sash } from 'vs/base/browser/ui/sash/sash';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Disposable, DisposableStore, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { IObservable, autorun, autorunWithStore, constObservable, derived, observableFromEvent, observableSignalFromEvent, observableValue, transaction } from 'vs/base/common/observable';
import { Constants } from 'vs/base/common/uint';
import { ElementSizeObserver } from 'vs/editor/browser/config/elementSizeObserver';
import { ICodeEditor, IDiffEditor, IDiffEditorConstructionOptions, IDiffLineInformation } from 'vs/editor/browser/editorBrowser';
import { EditorExtensionsRegistry, IDiffEditorContributionDescription } from 'vs/editor/browser/editorExtensions';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from 'vs/editor/browser/widget/codeEditorWidget';
import { IDiffCodeEditorWidgetOptions } from 'vs/editor/browser/widget/diffEditorWidget';
import { EditorLayoutInfo, EditorOptions, IDiffEditorOptions, ValidDiffEditorBaseOptions, clampedFloat, clampedInt, boolean as validateBooleanOption, stringSet as validateStringSetOption } from 'vs/editor/common/config/editorOptions';
import { IDimension } from 'vs/editor/common/core/dimension';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { IRange, Range } from 'vs/editor/common/core/range';
import { ISelection, Selection } from 'vs/editor/common/core/selection';
import { IDiffComputationResult, ILineChange } from 'vs/editor/common/diff/smartLinesDiffComputer';
import { EditorType, IContentSizeChangedEvent, IDiffEditorModel, IDiffEditorViewState, IEditorAction, IEditorDecorationsCollection, ScrollType } from 'vs/editor/common/editorCommon';
import { IModelDecorationsChangeAccessor, IModelDeltaDecoration } from 'vs/editor/common/model';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IEditorProgressService } from 'vs/platform/progress/common/progress';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { Emitter, Event } from 'vs/base/common/event';
import { IEditorConstructionOptions } from 'vs/editor/browser/config/editorConfiguration';
import { localize } from 'vs/nls';
import { OverviewRulerZone } from 'vs/editor/common/viewModel/overviewZoneManager';
import { WorkerBasedDocumentDiffProvider } from 'vs/editor/browser/widget/workerBasedDocumentDiffProvider';
import { IDocumentDiff, IDocumentDiffProvider, IDocumentDiffProviderOptions } from 'vs/editor/common/diff/documentDiffProvider';
import { timeout } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import 'vs/css!./style';

export class DiffEditorWidget2 extends Disposable implements IDiffEditor {
	private static readonly ONE_OVERVIEW_WIDTH = 15;
	private static readonly ENTIRE_DIFF_OVERVIEW_WIDTH = DiffEditorWidget2.ONE_OVERVIEW_WIDTH * 2;

	private static idCounter = 0;

	private readonly _id = ++DiffEditorWidget2.idCounter;
	private readonly _modifiedEditor: CodeEditorWidget;
	private readonly _originalEditor: CodeEditorWidget;
	private readonly _instantiationService: IInstantiationService;
	private readonly _contextKeyService: IContextKeyService;
	private readonly _rootSizeObserver: ElementSizeObserver;
	private _options: ValidDiffEditorBaseOptions;

	private readonly _model = observableValue<IDiffEditorModel | null>('diffEditorModel', null);
	private readonly _diffModel = observableValue<DiffModel | null>('diffModel', null);
	public readonly onDidChangeModel = Event.fromObservableLight(this._model);

	private readonly _onDidContentSizeChange = this._register(new Emitter<IContentSizeChangedEvent>());
	public readonly onDidContentSizeChange: Event<IContentSizeChangedEvent> = this._onDidContentSizeChange.event;

	public readonly onDidUpdateDiff: Event<void> = e => {
		return { dispose: () => { } };
	};

	onDidDispose(listener: () => void): IDisposable {
		return ({
			dispose() {

			},
		});
		// TODO throw new Error('Method not implemented.');
	}

	private readonly elements = h('div.monaco-diff-editor.side-by-side', { style: { position: 'relative', height: '100%' } }, [
		h('div.editor.original@original', { style: { position: 'absolute', height: '100%' } }),
		h('div.editor.modified@modified', { style: { position: 'absolute', height: '100%' } }),
	]);

	constructor(private readonly _domElement: HTMLElement,
		options: Readonly<IDiffEditorConstructionOptions>,
		codeEditorWidgetOptions: IDiffCodeEditorWidgetOptions,
		@IClipboardService clipboardService: IClipboardService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IThemeService private readonly _themeService: IThemeService,
		@INotificationService notificationService: INotificationService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IEditorProgressService private readonly _editorProgressService: IEditorProgressService
	) {
		super();
		_codeEditorService.willCreateDiffEditor();

		this._contextKeyService = this._register(contextKeyService.createScoped(_domElement));
		this._contextKeyService.createKey('isInDiffEditor', true);
		this._contextKeyService.createKey('isInEmbeddedDiffEditor',
			typeof options.isInEmbeddedEditor !== 'undefined' ? options.isInEmbeddedEditor : false
		);

		this._instantiationService = instantiationService.createChild(new ServiceCollection([IContextKeyService, this._contextKeyService]));

		this._options = validateDiffEditorOptions(options || {}, {
			enableSplitViewResizing: true,
			splitViewDefaultRatio: 0.5,
			renderSideBySide: true,
			renderMarginRevertIcon: true,
			maxComputationTime: 5000,
			maxFileSize: 50,
			ignoreTrimWhitespace: true,
			renderIndicators: true,
			originalEditable: false,
			diffCodeLens: false,
			renderOverviewRuler: true,
			diffWordWrap: 'inherit',
			diffAlgorithm: 'advanced',
			accessibilityVerbose: false
		});


		this._register(this._themeService.onDidColorThemeChange(t => {
			/*if (this._strategy && this._strategy.applyColors(t)) {
				this._updateDecorationsRunner.schedule();
			}*/
			//this._containerDomElement.className = DiffEditorWidget._getClassName(this._themeService.getColorTheme(), this._options.renderSideBySide);
		}));



		this._domElement.appendChild(this.elements.root);


		this._rootSizeObserver = this._register(new ElementSizeObserver(this.elements.root, options.dimension));
		this._register(this._rootSizeObserver.onDidChange(() => this._doLayout()));
		if (options.automaticLayout) {
			this._rootSizeObserver.startObserving();
		}

		this._originalEditor = this._createLeftHandSideEditor(options, codeEditorWidgetOptions.originalEditor || {});
		this._modifiedEditor = this._createRightHandSideEditor(options, codeEditorWidgetOptions.modifiedEditor || {});

		this._register(applyObservableDecorations(this._originalEditor, derived('decorations', (reader) => {
			const decorations: IModelDeltaDecoration[] = [];

			const diff = this._diffModel.read(reader)?.diff.read(reader);
			if (diff) {
				for (const c of diff.changes) {
					for (const i of c.innerChanges || []) {
						decorations.push({
							range: i.originalRange,
							options: {
								className: 'diff-line-delete',
								description: 'diff-line-delete'
							}
						});
					}
				}
			}

			return decorations;
		})));

		this._register(autorunWithStore((reader, store) => {
			// if disabled, return null

			const viewportDomElement = createFastDomNode(document.createElement('div'));
			viewportDomElement.setClassName('diffViewport');
			viewportDomElement.setPosition('absolute');

			const diffOverviewRoot = h('div.diffOverview', {
				style: { position: 'absolute', top: '0px', width: DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH + 'px' }
			}).root;
			diffOverviewRoot.appendChild(viewportDomElement.domNode);
			store.add(addStandardDisposableListener(diffOverviewRoot, EventType.POINTER_DOWN, (e) => {
				this._modifiedEditor.delegateVerticalScrollbarPointerDown(e);
			}));
			store.add(addDisposableListener(diffOverviewRoot, EventType.MOUSE_WHEEL, (e: IMouseWheelEvent) => {
				this._modifiedEditor.delegateScrollFromMouseWheelEvent(e);
			}, { passive: false }));

			store.add(appendRemoveOnDispose(this.elements.root, diffOverviewRoot));

			store.add(autorunWithStore((reader, store) => {
				this._model.read(reader);

				const originalOverviewRuler = this._originalEditor.createOverviewRuler('original diffOverviewRuler');
				if (originalOverviewRuler) {
					store.add(originalOverviewRuler);
					store.add(appendRemoveOnDispose(diffOverviewRoot, originalOverviewRuler.getDomNode()));
				}

				const modifiedOverviewRuler = this._modifiedEditor.createOverviewRuler('modified diffOverviewRuler');
				if (modifiedOverviewRuler) {
					store.add(modifiedOverviewRuler);
					store.add(appendRemoveOnDispose(diffOverviewRoot, modifiedOverviewRuler.getDomNode()));
				}

				if (!originalOverviewRuler || !modifiedOverviewRuler) {
					return;
				}

				originalOverviewRuler?.setZones([
					new OverviewRulerZone(0, 10, 0, 'red'),
				]);

				const scrollTopObservable = observableFromEvent(this._modifiedEditor.onDidScrollChange, () => this._modifiedEditor.getScrollTop());
				const scrollHeightObservable = observableFromEvent(this._modifiedEditor.onDidScrollChange, () => this._modifiedEditor.getScrollHeight());

				store.add(autorun('layout', (reader) => {
					const height = this._rootHeight.read(reader);
					const width = this._rootWidth.read(reader);
					const layoutInfo = this._modifiedEditorLayoutInfo.read(reader);
					if (layoutInfo) {
						const freeSpace = DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH - 2 * DiffEditorWidget2.ONE_OVERVIEW_WIDTH;
						originalOverviewRuler.setLayout({
							top: 0,
							height: height,
							right: freeSpace + DiffEditorWidget2.ONE_OVERVIEW_WIDTH,
							width: DiffEditorWidget2.ONE_OVERVIEW_WIDTH,
						});
						modifiedOverviewRuler.setLayout({
							top: 0,
							height: height,
							right: 0,
							width: DiffEditorWidget2.ONE_OVERVIEW_WIDTH,
						});
						const scrollTop = scrollTopObservable.read(reader);
						const scrollHeight = scrollHeightObservable.read(reader);

						const computedAvailableSize = Math.max(0, layoutInfo.height);
						const computedRepresentableSize = Math.max(0, computedAvailableSize - 2 * 0);
						const computedRatio = scrollHeight > 0 ? (computedRepresentableSize / scrollHeight) : 0;

						const computedSliderSize = Math.max(0, Math.floor(layoutInfo.height * computedRatio));
						const computedSliderPosition = Math.floor(scrollTop * computedRatio);

						viewportDomElement.setTop(computedSliderPosition);
						viewportDomElement.setHeight(computedSliderSize);
					} else {
						viewportDomElement.setTop(0);
						viewportDomElement.setHeight(0);
					}

					diffOverviewRoot.style.height = height + 'px';
					diffOverviewRoot.style.left = (width - DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH) + 'px';
					viewportDomElement.setWidth(DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH);
				}));

			}, 'update2'));

		}, 'update'));


		const contributions: IDiffEditorContributionDescription[] = EditorExtensionsRegistry.getDiffEditorContributions();
		for (const desc of contributions) {
			try {
				this._register(instantiationService.createInstance(desc.ctor, this));
			} catch (err) {
				onUnexpectedError(err);
			}
		}

		this._codeEditorService.addDiffEditor(this);






		this._doLayout();
	}



	private readonly _rootHeight = observableValue<number>('rootHeight', 0);
	private readonly _rootWidth = observableValue<number>('rootWidth', 0);
	private readonly _modifiedEditorLayoutInfo = observableValue<EditorLayoutInfo | null>('layoutInfo', null);

	private readonly _sash = new DiffEditorSash(this.elements.root, {
		getHeight: () => {
			return this._rootHeight.get();
		},
		getWidth: () => {
			return this._rootWidth.get();
		},
	}, () => this._doLayout());

	private _doLayout(): void {
		const width = this._rootSizeObserver.getWidth();
		const height = this._rootSizeObserver.getHeight();

		const splitPoint = this._sash.sashLayout();

		this.elements.original.style.width = splitPoint + 'px';
		this.elements.original.style.left = '0px';

		this.elements.modified.style.width = (width - splitPoint) + 'px';
		this.elements.modified.style.left = splitPoint + 'px';

		this._originalEditor.layout({ width: splitPoint, height: height });
		this._modifiedEditor.layout({ width: width - splitPoint - (this._options.renderOverviewRuler ? DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH : 0), height: height });

		transaction(tx => {
			this._rootHeight.set(height, tx);
			this._rootWidth.set(width, tx);
			this._modifiedEditorLayoutInfo.set(this._modifiedEditor.getLayoutInfo(), tx);
		});
	}

	static _getClassName(arg0: any, renderSideBySide: boolean): any {
		//throw new Error('Method not implemented.');
	}

	private _createLeftHandSideEditor(options: Readonly<IDiffEditorConstructionOptions>, codeEditorWidgetOptions: ICodeEditorWidgetOptions): CodeEditorWidget {
		const editor = this._createInnerEditor(this._instantiationService, this.elements.original, this._adjustOptionsForLeftHandSide(options), codeEditorWidgetOptions);

		/*
		this._register(editor.onDidChangeViewZones(() => {
			this._onViewZonesChanged();
		}));

		this._register(editor.onDidChangeConfiguration((e) => {
			if (!editor.getModel()) {
				return;
			}
			if (e.hasChanged(EditorOption.fontInfo)) {
				this._updateDecorationsRunner.schedule();
			}
			if (e.hasChanged(EditorOption.wrappingInfo)) {
				this._updateDecorationsRunner.cancel();
				this._updateDecorations();
			}
		}));

		this._register(editor.onDidChangeModelContent(() => {
			if (this._isVisible) {
				this._beginUpdateDecorationsSoon();
			}
		}));

		const isInDiffLeftEditorKey = this._contextKeyService.createKey<boolean>('isInDiffLeftEditor', editor.hasWidgetFocus());
		this._register(editor.onDidFocusEditorWidget(() => isInDiffLeftEditorKey.set(true)));
		this._register(editor.onDidBlurEditorWidget(() => isInDiffLeftEditorKey.set(false)));

		this._register(editor.onDidContentSizeChange(e => {
			const width = this._originalEditor.getContentWidth() + this._modifiedEditor.getContentWidth() + DiffEditorWidget.ONE_OVERVIEW_WIDTH;
			const height = Math.max(this._modifiedEditor.getContentHeight(), this._originalEditor.getContentHeight());

			this._onDidContentSizeChange.fire({
				contentHeight: height,
				contentWidth: width,
				contentHeightChanged: e.contentHeightChanged,
				contentWidthChanged: e.contentWidthChanged
			});
		}));
		*/

		return editor;
	}

	private _createRightHandSideEditor(options: Readonly<IDiffEditorConstructionOptions>, codeEditorWidgetOptions: ICodeEditorWidgetOptions): CodeEditorWidget {
		const editor = this._createInnerEditor(this._instantiationService, this.elements.modified, this._adjustOptionsForRightHandSide(options), codeEditorWidgetOptions);

		/*
		this._register(editor.onDidChangeViewZones(() => {
			this._onViewZonesChanged();
		}));

		this._register(editor.onDidChangeConfiguration((e) => {
			if (!editor.getModel()) {
				return;
			}
			if (e.hasChanged(EditorOption.fontInfo)) {
				this._updateDecorationsRunner.schedule();
			}
			if (e.hasChanged(EditorOption.wrappingInfo)) {
				this._updateDecorationsRunner.cancel();
				this._updateDecorations();
			}
		}));

		this._register(editor.onDidChangeHiddenAreas(() => {
			this._updateDecorationsRunner.cancel();
			this._updateDecorations();
		}));

		this._register(editor.onDidChangeModelContent(() => {
			if (this._isVisible) {
				this._beginUpdateDecorationsSoon();
			}
		}));

		this._register(editor.onDidChangeModelOptions((e) => {
			if (e.tabSize) {
				this._updateDecorationsRunner.schedule();
			}
		}));*/

		const isInDiffRightEditorKey = this._contextKeyService.createKey<boolean>('isInDiffRightEditor', editor.hasWidgetFocus());
		this._register(editor.onDidFocusEditorWidget(() => isInDiffRightEditorKey.set(true)));
		this._register(editor.onDidBlurEditorWidget(() => isInDiffRightEditorKey.set(false)));

		this._register(editor.onDidContentSizeChange(e => {
			const width = this._originalEditor.getContentWidth() + this._modifiedEditor.getContentWidth() + DiffEditorWidget2.ONE_OVERVIEW_WIDTH;
			const height = Math.max(this._modifiedEditor.getContentHeight(), this._originalEditor.getContentHeight());

			this._onDidContentSizeChange.fire({
				contentHeight: height,
				contentWidth: width,
				contentHeightChanged: e.contentHeightChanged,
				contentWidthChanged: e.contentWidthChanged
			});
		}));

		// Revert change when an arrow is clicked.
		/*TODO
		this._register(editor.onMouseDown(event => {
			if (!event.event.rightButton && event.target.position && event.target.element?.className.includes('arrow-revert-change')) {
				const lineNumber = event.target.position.lineNumber;
				const viewZone = event.target as editorBrowser.IMouseTargetViewZone | undefined;
				const change = this._diffComputationResult?.changes.find(c =>
					// delete change
					viewZone?.detail.afterLineNumber === c.modifiedStartLineNumber ||
					// other changes
					(c.modifiedEndLineNumber > 0 && c.modifiedStartLineNumber === lineNumber));
				if (change) {
					this.revertChange(change);
				}
				event.event.stopPropagation();
				this._updateDecorations();
				return;
			}
		}));*/

		return editor;
	}


	private _adjustOptionsForSubEditor(options: Readonly<IDiffEditorConstructionOptions>): IEditorConstructionOptions {
		const clonedOptions = { ...options };
		clonedOptions.inDiffEditor = true;
		clonedOptions.automaticLayout = false;
		// Clone scrollbar options before changing them
		clonedOptions.scrollbar = { ...(clonedOptions.scrollbar || {}) };
		clonedOptions.scrollbar.vertical = 'visible';
		clonedOptions.folding = false;
		clonedOptions.codeLens = this._options.diffCodeLens;
		clonedOptions.fixedOverflowWidgets = true;
		// clonedOptions.lineDecorationsWidth = '2ch';
		// Clone minimap options before changing them
		clonedOptions.minimap = { ...(clonedOptions.minimap || {}) };
		clonedOptions.minimap.enabled = false;
		return clonedOptions;
	}

	private _adjustOptionsForLeftHandSide(options: Readonly<IDiffEditorConstructionOptions>): IEditorConstructionOptions {
		const result = this._adjustOptionsForSubEditor(options);
		if (!this._options.renderSideBySide) {
			// never wrap hidden editor
			result.wordWrapOverride1 = 'off';
			result.wordWrapOverride2 = 'off';
		} else {
			result.wordWrapOverride1 = this._options.diffWordWrap;
		}
		if (options.originalAriaLabel) {
			result.ariaLabel = options.originalAriaLabel;
		}
		this._updateAriaLabel(result);
		result.readOnly = !this._options.originalEditable;
		result.dropIntoEditor = { enabled: !result.readOnly };
		result.extraEditorClassName = 'original-in-monaco-diff-editor';
		return {
			...result,
			dimension: {
				height: 0,
				width: 0
			}
		};
	}

	private _adjustOptionsForRightHandSide(options: Readonly<IDiffEditorConstructionOptions>): IEditorConstructionOptions {
		const result = this._adjustOptionsForSubEditor(options);
		if (options.modifiedAriaLabel) {
			result.ariaLabel = options.modifiedAriaLabel;
		}
		this._updateAriaLabel(result);
		result.wordWrapOverride1 = this._options.diffWordWrap;
		result.revealHorizontalRightPadding = EditorOptions.revealHorizontalRightPadding.defaultValue + DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH;
		result.scrollbar!.verticalHasArrows = false;
		result.extraEditorClassName = 'modified-in-monaco-diff-editor';
		return {
			...result,
			dimension: {
				height: 0,
				width: 0
			}
		};
	}

	private _updateAriaLabel(options: IEditorConstructionOptions): void {
		const ariaNavigationTip = localize('diff-aria-navigation-tip', ' use Shift + F7 to navigate changes');

		let ariaLabel = options.ariaLabel;
		if (this._options.accessibilityVerbose) {
			ariaLabel += ariaNavigationTip;
		} else if (ariaLabel) {
			ariaLabel = ariaLabel.replaceAll(ariaNavigationTip, '');
		}
		options.ariaLabel = ariaLabel;
	}

	private _isHandlingScrollEvent = false;

	protected _createInnerEditor(instantiationService: IInstantiationService, container: HTMLElement, options: Readonly<IEditorConstructionOptions>, editorWidgetOptions: ICodeEditorWidgetOptions): CodeEditorWidget {
		const editor = instantiationService.createInstance(CodeEditorWidget, container, options, editorWidgetOptions);

		this._register(editor.onDidScrollChange((e) => {
			if (this._isHandlingScrollEvent) {
				return;
			}
			if (!e.scrollTopChanged && !e.scrollLeftChanged && !e.scrollHeightChanged) {
				return;
			}
			this._isHandlingScrollEvent = true;
			try {
				const otherEditor = editor === this._originalEditor ? this._modifiedEditor : this._originalEditor;
				otherEditor.setScrollPosition({
					scrollLeft: e.scrollLeft,
					scrollTop: e.scrollTop
				});
			} finally {
				this._isHandlingScrollEvent = false;
			}
		}));

		return editor;
	}


	getContainerDomNode(): HTMLElement {
		return this._domElement;
	}

	saveViewState(): IDiffEditorViewState | null {
		return null;
		//throw new Error('Method not implemented.');
	}
	restoreViewState(state: IDiffEditorViewState | null): void {
		//throw new Error('Method not implemented.');
	}

	getModel(): IDiffEditorModel | null { return this._model.get(); }
	setModel(model: IDiffEditorModel | null): void {
		this._originalEditor.setModel(model ? model.original : null);
		this._modifiedEditor.setModel(model ? model.modified : null);

		this._model.set(model, undefined);

		this._diffModel.set(model ? new DiffModel(
			model,
			constObservable(false),
			constObservable(0),
			this._instantiationService.createInstance(WorkerBasedDocumentDiffProvider, this._options)
		) : null, undefined);

		/*this._modifiedEditor.createDecorationsCollection([
			{
				range: new Range(1, 1, 10, 1),
				options: {
					description: 'diff-editor-line-insert',
					className: 'line-insert',
					marginClassName: 'gutter-insert',
					isWholeLine: true
				}
			}
		]);*/
	}

	getOriginalEditor(): ICodeEditor { return this._originalEditor; }
	getModifiedEditor(): ICodeEditor { return this._modifiedEditor; }

	updateOptions(_newOptions: IDiffEditorOptions): void {
		const newOptions = validateDiffEditorOptions(_newOptions, this._options);
		const changed = changedDiffEditorOptions(this._options, newOptions);
		this._options = newOptions;

		//const beginUpdateDecorations = (changed.ignoreTrimWhitespace || changed.renderIndicators || changed.renderMarginRevertIcon);
		//const beginUpdateDecorationsSoon = (this._isVisible && (changed.maxComputationTime || changed.maxFileSize));
		//this._documentDiffProvider.setOptions(newOptions);

		/*if (beginUpdateDecorations) {
			this._beginUpdateDecorations();
		} else if (beginUpdateDecorationsSoon) {
			this._beginUpdateDecorationsSoon();
		}*/

		this._modifiedEditor.updateOptions(this._adjustOptionsForRightHandSide(_newOptions));
		this._originalEditor.updateOptions(this._adjustOptionsForLeftHandSide(_newOptions));

		// enableSplitViewResizing
		//this._strategy.setEnableSplitViewResizing(this._options.enableSplitViewResizing, this._options.splitViewDefaultRatio);

		// renderSideBySide
		/*
		if (changed.renderSideBySide) {
			if (this._options.renderSideBySide) {
				this._setStrategy(new DiffEditorWidgetSideBySide(this._createDataSource(), this._options.enableSplitViewResizing, this._options.splitViewDefaultRatio));
			} else {
				this._setStrategy(new DiffEditorWidgetInline(this._createDataSource(), this._options.enableSplitViewResizing));
			}
			// Update class name
			this._containerDomElement.className = DiffEditorWidget._getClassName(this._themeService.getColorTheme(), this._options.renderSideBySide);
		}*/
	}




	setBoundarySashes(sashes: IBoundarySashes): void {
		this._sash.setBoundarySashes(sashes);
	}




	getId(): string { return this.getEditorType() + ':' + this._id; }
	getEditorType(): string { return EditorType.IDiffEditor; }

	onVisible(): void {
		// TODO: Only compute diffs when diff editor is visible
		this._originalEditor.onVisible();
		this._modifiedEditor.onVisible();
	}

	onHide(): void {
		this._originalEditor.onHide();
		this._modifiedEditor.onHide();
	}

	layout(dimension?: IDimension | undefined): void {
		this._rootSizeObserver.observe(dimension);
	}

	hasTextFocus(): boolean {
		return this._originalEditor.hasTextFocus() || this._modifiedEditor.hasTextFocus();
	}

	// #region legacy

	public get ignoreTrimWhitespace(): boolean {
		return this._options.ignoreTrimWhitespace;
	}

	public get maxComputationTime(): number {
		return this._options.maxComputationTime;
	}

	public get renderSideBySide(): boolean {
		return this._options.renderSideBySide;
	}

	getLineChanges(): ILineChange[] | null {
		return null;
		//throw new Error('Method not implemented.');
	}
	getDiffComputationResult(): IDiffComputationResult | null {
		return null;
		//throw new Error('Method not implemented.');
	}
	getDiffLineInformationForOriginal(lineNumber: number): IDiffLineInformation | null {
		return null;
		//throw new Error('Method not implemented.');
	}
	getDiffLineInformationForModified(lineNumber: number): IDiffLineInformation | null {
		return null;
		//throw new Error('Method not implemented.');
	}
	// #endregion

	// #region editorBrowser.IDiffEditor: Delegating to modified Editor

	public getVisibleColumnFromPosition(position: IPosition): number {
		return this._modifiedEditor.getVisibleColumnFromPosition(position);
	}

	public getStatusbarColumn(position: IPosition): number {
		return this._modifiedEditor.getStatusbarColumn(position);
	}

	public getPosition(): Position | null {
		return this._modifiedEditor.getPosition();
	}

	public setPosition(position: IPosition, source: string = 'api'): void {
		this._modifiedEditor.setPosition(position, source);
	}

	public revealLine(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLine(lineNumber, scrollType);
	}

	public revealLineInCenter(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLineInCenter(lineNumber, scrollType);
	}

	public revealLineInCenterIfOutsideViewport(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLineInCenterIfOutsideViewport(lineNumber, scrollType);
	}

	public revealLineNearTop(lineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLineNearTop(lineNumber, scrollType);
	}

	public revealPosition(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPosition(position, scrollType);
	}

	public revealPositionInCenter(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPositionInCenter(position, scrollType);
	}

	public revealPositionInCenterIfOutsideViewport(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPositionInCenterIfOutsideViewport(position, scrollType);
	}

	public revealPositionNearTop(position: IPosition, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealPositionNearTop(position, scrollType);
	}

	public getSelection(): Selection | null {
		return this._modifiedEditor.getSelection();
	}

	public getSelections(): Selection[] | null {
		return this._modifiedEditor.getSelections();
	}

	public setSelection(range: IRange, source?: string): void;
	public setSelection(editorRange: Range, source?: string): void;
	public setSelection(selection: ISelection, source?: string): void;
	public setSelection(editorSelection: Selection, source?: string): void;
	public setSelection(something: any, source: string = 'api'): void {
		this._modifiedEditor.setSelection(something, source);
	}

	public setSelections(ranges: readonly ISelection[], source: string = 'api'): void {
		this._modifiedEditor.setSelections(ranges, source);
	}

	public revealLines(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLines(startLineNumber, endLineNumber, scrollType);
	}

	public revealLinesInCenter(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLinesInCenter(startLineNumber, endLineNumber, scrollType);
	}

	public revealLinesInCenterIfOutsideViewport(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLinesInCenterIfOutsideViewport(startLineNumber, endLineNumber, scrollType);
	}

	public revealLinesNearTop(startLineNumber: number, endLineNumber: number, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealLinesNearTop(startLineNumber, endLineNumber, scrollType);
	}

	public revealRange(range: IRange, scrollType: ScrollType = ScrollType.Smooth, revealVerticalInCenter: boolean = false, revealHorizontal: boolean = true): void {
		this._modifiedEditor.revealRange(range, scrollType, revealVerticalInCenter, revealHorizontal);
	}

	public revealRangeInCenter(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeInCenter(range, scrollType);
	}

	public revealRangeInCenterIfOutsideViewport(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeInCenterIfOutsideViewport(range, scrollType);
	}

	public revealRangeNearTop(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeNearTop(range, scrollType);
	}

	public revealRangeNearTopIfOutsideViewport(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeNearTopIfOutsideViewport(range, scrollType);
	}

	public revealRangeAtTop(range: IRange, scrollType: ScrollType = ScrollType.Smooth): void {
		this._modifiedEditor.revealRangeAtTop(range, scrollType);
	}

	public getSupportedActions(): IEditorAction[] {
		return this._modifiedEditor.getSupportedActions();
	}

	public focus(): void {
		this._modifiedEditor.focus();
	}

	public trigger(source: string | null | undefined, handlerId: string, payload: any): void {
		this._modifiedEditor.trigger(source, handlerId, payload);
	}

	public createDecorationsCollection(decorations?: IModelDeltaDecoration[]): IEditorDecorationsCollection {
		return this._modifiedEditor.createDecorationsCollection(decorations);
	}

	public changeDecorations(callback: (changeAccessor: IModelDecorationsChangeAccessor) => any): any {
		return this._modifiedEditor.changeDecorations(callback);
	}

	// #endregion
}

class DiffModel extends Disposable {
	private readonly _isDiffUpToDate = observableValue<boolean>('isDiffUpToDate', false);
	public readonly isDiffUpToDate: IObservable<boolean> = this._isDiffUpToDate;

	private readonly _diff = observableValue<IDocumentDiff | undefined>('diff', undefined);
	public readonly diff: IObservable<IDocumentDiff | undefined> = this._diff;

	constructor(
		private readonly _model: IDiffEditorModel,
		ignoreTrimWhitespace: IObservable<boolean>,
		maxComputationTimeMs: IObservable<number>,
		documentDiffProvider: IDocumentDiffProvider,
	) {
		super();

		const modifiedVersionId = observableFromEvent(e => _model.modified.onDidChangeContent(e), () => _model.modified.getVersionId());
		const originalVersionId = observableFromEvent(e => _model.original.onDidChangeContent(e), () => _model.original.getVersionId());
		const documentDiffProviderOptionChanged = observableSignalFromEvent('documentDiffProviderOptionChanged', documentDiffProvider.onDidChange);

		this._register(autorunWithStore((reader, store) => {
			modifiedVersionId.read(reader);
			originalVersionId.read(reader);
			documentDiffProviderOptionChanged.read(reader);
			const ignoreTrimWhitespaceVal = ignoreTrimWhitespace.read(reader);
			const maxComputationTimeMsVal = maxComputationTimeMs.read(reader);

			this._isDiffUpToDate.set(false, undefined);

			const cancellationTokenSrc = new CancellationTokenSource();
			store.add(toDisposable(() => cancellationTokenSrc.dispose(true)));

			timeout(1000, cancellationTokenSrc.token).then(async () => {
				const result = await documentDiffProvider.computeDiff(_model.original, _model.modified, {
					ignoreTrimWhitespace: ignoreTrimWhitespaceVal,
					maxComputationTimeMs: maxComputationTimeMsVal,
				});

				if (cancellationTokenSrc.token.isCancellationRequested) {
					return;
				}

				transaction(tx => {
					this._diff.set(result, tx);
					this._isDiffUpToDate.set(true, tx);
				});

			});
		}, 'compute diff'));
	}
}

function validateDiffEditorOptions(options: Readonly<IDiffEditorOptions>, defaults: ValidDiffEditorBaseOptions): ValidDiffEditorBaseOptions {
	return {
		enableSplitViewResizing: validateBooleanOption(options.enableSplitViewResizing, defaults.enableSplitViewResizing),
		splitViewDefaultRatio: clampedFloat(options.splitViewDefaultRatio, 0.5, 0.1, 0.9),
		renderSideBySide: validateBooleanOption(options.renderSideBySide, defaults.renderSideBySide),
		renderMarginRevertIcon: validateBooleanOption(options.renderMarginRevertIcon, defaults.renderMarginRevertIcon),
		maxComputationTime: clampedInt(options.maxComputationTime, defaults.maxComputationTime, 0, Constants.MAX_SAFE_SMALL_INTEGER),
		maxFileSize: clampedInt(options.maxFileSize, defaults.maxFileSize, 0, Constants.MAX_SAFE_SMALL_INTEGER),
		ignoreTrimWhitespace: validateBooleanOption(options.ignoreTrimWhitespace, defaults.ignoreTrimWhitespace),
		renderIndicators: validateBooleanOption(options.renderIndicators, defaults.renderIndicators),
		originalEditable: validateBooleanOption(options.originalEditable, defaults.originalEditable),
		diffCodeLens: validateBooleanOption(options.diffCodeLens, defaults.diffCodeLens),
		renderOverviewRuler: validateBooleanOption(options.renderOverviewRuler, defaults.renderOverviewRuler),
		diffWordWrap: validateDiffWordWrap(options.diffWordWrap, defaults.diffWordWrap),
		diffAlgorithm: validateStringSetOption(options.diffAlgorithm, defaults.diffAlgorithm, ['legacy', 'advanced'], { 'smart': 'legacy', 'experimental': 'advanced' }),
		accessibilityVerbose: validateBooleanOption(options.accessibilityVerbose, defaults.accessibilityVerbose),
	};
}

function validateDiffWordWrap(value: 'off' | 'on' | 'inherit' | undefined, defaultValue: 'off' | 'on' | 'inherit'): 'off' | 'on' | 'inherit' {
	return validateStringSetOption<'off' | 'on' | 'inherit'>(value, defaultValue, ['off', 'on', 'inherit']);
}

function changedDiffEditorOptions(a: ValidDiffEditorBaseOptions, b: ValidDiffEditorBaseOptions) {
	return {
		enableSplitViewResizing: (a.enableSplitViewResizing !== b.enableSplitViewResizing),
		renderSideBySide: (a.renderSideBySide !== b.renderSideBySide),
		renderMarginRevertIcon: (a.renderMarginRevertIcon !== b.renderMarginRevertIcon),
		maxComputationTime: (a.maxComputationTime !== b.maxComputationTime),
		maxFileSize: (a.maxFileSize !== b.maxFileSize),
		ignoreTrimWhitespace: (a.ignoreTrimWhitespace !== b.ignoreTrimWhitespace),
		renderIndicators: (a.renderIndicators !== b.renderIndicators),
		originalEditable: (a.originalEditable !== b.originalEditable),
		diffCodeLens: (a.diffCodeLens !== b.diffCodeLens),
		renderOverviewRuler: (a.renderOverviewRuler !== b.renderOverviewRuler),
		diffWordWrap: (a.diffWordWrap !== b.diffWordWrap),
		diffAlgorithm: (a.diffAlgorithm !== b.diffAlgorithm),
		accessibilityVerbose: (a.accessibilityVerbose !== b.accessibilityVerbose),
	};
}

function appendRemoveOnDispose(parent: HTMLElement, child: HTMLElement) {
	parent.appendChild(child);
	return toDisposable(() => {
		parent.removeChild(child);
	});
}

// TODO make utility
export function applyObservableDecorations(editor: ICodeEditor, decorations: IObservable<IModelDeltaDecoration[]>): IDisposable {
	const d = new DisposableStore();
	const decorationsCollection = editor.createDecorationsCollection();
	d.add(autorun(`Apply decorations from ${decorations.debugName}`, reader => {
		const d = decorations.read(reader);
		decorationsCollection.set(d);
	}));
	d.add({
		dispose: () => {
			decorationsCollection.clear();
		}
	});
	return d;
}



class DiffEditorSash extends Disposable {
	private readonly _sash: Sash;
	private _defaultRatio: number;
	private _sashRatio: number | null;
	private _sashLeft: number | null;
	private _startSashPosition: number | null;

	constructor(domNode: HTMLElement, private readonly dimensions: { getHeight(): number; getWidth(): number }, private readonly _doLayout: () => void) {
		super();

		this._defaultRatio = 0.5; // TODO
		this._sashRatio = null;
		this._sashLeft = null;
		this._startSashPosition = null;
		this._sash = this._register(new Sash(domNode, {
			getVerticalSashTop: (sash: Sash): number => {
				return 0;
			},

			getVerticalSashLeft: (sash: Sash): number => {
				return this._sashLeft!;
			},

			getVerticalSashHeight: (sash: Sash): number => {
				return this.dimensions.getHeight();
			},
		}, { orientation: Orientation.VERTICAL }));

		/*if (this._disableSash) {
			this._sash.state = SashState.Disabled;
		}
		*/

		this._sash.onDidStart(() => this._onSashDragStart());
		this._sash.onDidChange((e: ISashEvent) => this._onSashDrag(e));
		this._sash.onDidEnd(() => this._onSashDragEnd());
		this._sash.onDidReset(() => this._onSashReset());
	}

	setBoundarySashes(sashes: IBoundarySashes): void {
		this._sash.orthogonalEndSash = sashes.bottom;
	}

	public sashLayout(sashRatio: number | null = this._sashRatio || this._defaultRatio): number {
		const w = this.dimensions.getWidth();
		const contentWidth = w; //- (/*this._dataSource.getOptions().renderOverviewRuler*/ false ? DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH : 0);

		let sashPosition = Math.floor((sashRatio || this._defaultRatio) * contentWidth);
		const midPoint = Math.floor(this._defaultRatio * contentWidth);

		sashPosition = /*this._disableSash*/ false ? midPoint : sashPosition || midPoint;

		const MINIMUM_EDITOR_WIDTH = 100;

		if (contentWidth > MINIMUM_EDITOR_WIDTH * 2) {
			if (sashPosition < MINIMUM_EDITOR_WIDTH) {
				sashPosition = MINIMUM_EDITOR_WIDTH;
			}

			if (sashPosition > contentWidth - MINIMUM_EDITOR_WIDTH) {
				sashPosition = contentWidth - MINIMUM_EDITOR_WIDTH;
			}
		} else {
			sashPosition = midPoint;
		}

		if (this._sashLeft !== sashPosition) {
			this._sashLeft = sashPosition;
		}
		this._sash.layout();

		return this._sashLeft;
	}


	private _onSashDragStart(): void {
		this._startSashPosition = this._sashLeft!;
	}

	private _onSashDrag(e: ISashEvent): void {
		const w = this.dimensions.getWidth();
		const contentWidth = w; // - DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH; //(/*this._dataSource.getOptions().renderOverviewRuler*/ false ? DiffEditorWidget2.ENTIRE_DIFF_OVERVIEW_WIDTH : 0);
		const sashPosition = this.sashLayout((this._startSashPosition! + (e.currentX - e.startX)) / contentWidth);
		this._sashRatio = sashPosition / contentWidth;
		this._doLayout();
	}

	private _onSashDragEnd(): void {
		this._sash.layout();
	}

	private _onSashReset(): void {
		this._sashRatio = this._defaultRatio;
		this._doLayout();
		this._sash.layout();
	}
}
