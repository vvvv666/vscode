/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { $, EventType, addDisposableListener, addStandardDisposableListener, h, reset } from 'vs/base/browser/dom';
import { createFastDomNode } from 'vs/base/browser/fastDomNode';
import { IMouseWheelEvent } from 'vs/base/browser/mouseEvent';
import { renderLabelWithIcons } from 'vs/base/browser/ui/iconLabel/iconLabels';
import { IBoundarySashes } from 'vs/base/browser/ui/sash/sash';
import { Color } from 'vs/base/common/color';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { IObservable, autorun, constObservable, derived, observableFromEvent, observableSignalFromEvent, observableValue, transaction } from 'vs/base/common/observable';
import { autorunWithStore2 } from 'vs/base/common/observableImpl/autorun';
import { Constants } from 'vs/base/common/uint';
import 'vs/css!./style';
import { IEditorConstructionOptions } from 'vs/editor/browser/config/editorConfiguration';
import { ElementSizeObserver } from 'vs/editor/browser/config/elementSizeObserver';
import { ICodeEditor, IDiffEditor, IDiffEditorConstructionOptions, IDiffLineInformation, IViewZoneChangeAccessor } from 'vs/editor/browser/editorBrowser';
import { EditorExtensionsRegistry, IDiffEditorContributionDescription } from 'vs/editor/browser/editorExtensions';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { CodeEditorWidget, ICodeEditorWidgetOptions } from 'vs/editor/browser/widget/codeEditorWidget';
import { IDiffCodeEditorWidgetOptions } from 'vs/editor/browser/widget/diffEditorWidget';
import { diffAddDecoration, diffDeleteDecoration, diffFullLineAddDecoration, diffFullLineDeleteDecoration } from 'vs/editor/browser/widget/diffEditorWidget2/decorations';
import { DiffEditorSash } from 'vs/editor/browser/widget/diffEditorWidget2/diffEditorSash';
import { IRangeAlignment, computeRangeAlignment } from 'vs/editor/browser/widget/diffEditorWidget2/lineAlignment';
import { appendRemoveOnDispose } from 'vs/editor/browser/widget/diffEditorWidget2/utils';
import { WorkerBasedDocumentDiffProvider } from 'vs/editor/browser/widget/workerBasedDocumentDiffProvider';
import { EditorLayoutInfo, EditorOptions, IDiffEditorOptions, ValidDiffEditorBaseOptions, clampedFloat, clampedInt, boolean as validateBooleanOption, stringSet as validateStringSetOption } from 'vs/editor/common/config/editorOptions';
import { IDimension } from 'vs/editor/common/core/dimension';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { IRange, Range } from 'vs/editor/common/core/range';
import { ISelection, Selection } from 'vs/editor/common/core/selection';
import { IDiffComputationResult, ILineChange } from 'vs/editor/common/diff/smartLinesDiffComputer';
import { EditorType, IContentSizeChangedEvent, IDiffEditorModel, IDiffEditorViewState, IEditorAction, IEditorDecorationsCollection, ScrollType } from 'vs/editor/common/editorCommon';
import { IModelDecorationsChangeAccessor, IModelDeltaDecoration } from 'vs/editor/common/model';
import { OverviewRulerZone } from 'vs/editor/common/viewModel/overviewZoneManager';
import { applyObservableDecorations } from 'vs/editor/contrib/inlineCompletions/browser/utils';
import { localize } from 'vs/nls';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IEditorProgressService } from 'vs/platform/progress/common/progress';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IContentWidgetAction } from 'vs/workbench/contrib/mergeEditor/browser/view/conflictActions';
import { FixedZoneWidget } from 'vs/workbench/contrib/mergeEditor/browser/view/fixedZoneWidget';
import { DiffModel } from './diffModel';
import { isDefined } from 'vs/base/common/types';

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

		this._domElement.appendChild(this.elements.root);

		this._rootSizeObserver = this._register(new ElementSizeObserver(this.elements.root, options.dimension));
		this._register(this._rootSizeObserver.onDidChange(() => this._doLayout()));
		if (options.automaticLayout) {
			this._rootSizeObserver.startObserving();
		}

		this._originalEditor = this._createLeftHandSideEditor(options, codeEditorWidgetOptions.originalEditor || {});
		this._modifiedEditor = this._createRightHandSideEditor(options, codeEditorWidgetOptions.modifiedEditor || {});

		const decorations = derived('decorations', (reader) => {
			const diff = this._diffModel.read(reader)?.diff.read(reader);
			if (!diff) {
				return null;
			}

			const originalDecorations: IModelDeltaDecoration[] = [];
			const modifiedDecorations: IModelDeltaDecoration[] = [];
			for (const c of diff.changes) {
				const fullRangeOriginal = c.originalRange.toInclusiveRange();
				if (fullRangeOriginal) {
					originalDecorations.push({ range: fullRangeOriginal, options: diffFullLineDeleteDecoration });
				}
				const fullRangeModified = c.modifiedRange.toInclusiveRange();
				if (fullRangeModified) {
					modifiedDecorations.push({ range: fullRangeModified, options: diffFullLineAddDecoration });
				}

				for (const i of c.innerChanges || []) {
					originalDecorations.push({ range: i.originalRange, options: diffDeleteDecoration });
					modifiedDecorations.push({ range: i.modifiedRange, options: diffAddDecoration });
				}
			}
			return { originalDecorations, modifiedDecorations };
		});
		this._register(applyObservableDecorations(this._originalEditor, decorations.map(d => d?.originalDecorations || [])));
		this._register(applyObservableDecorations(this._modifiedEditor, decorations.map(d => d?.modifiedDecorations || [])));


		const unchangedRegionViewZoneIdsOrig: string[] = [];
		const unchangedRegionViewZoneIdsMod: string[] = [];

		this._register(autorunWithStore2('update hidden ranges', (reader, store) => {
			const unchangedRegions = this._diffModel.read(reader)?.unchangedRegions.read(reader);
			if (!unchangedRegions) {
				return;
			}

			this._originalEditor.changeViewZones((aOrig) => {
				this._modifiedEditor.changeViewZones(aMod => {

					for (const id of unchangedRegionViewZoneIdsOrig) {
						aOrig.removeZone(id);
					}
					unchangedRegionViewZoneIdsOrig.length = 0;

					for (const id of unchangedRegionViewZoneIdsMod) {
						aMod.removeZone(id);
					}
					unchangedRegionViewZoneIdsMod.length = 0;

					for (const r of unchangedRegions) {
						const atTop = r.modifiedLineNumber !== 1;
						const atBottom = r.modifiedRange.endLineNumberExclusive !== this._modifiedEditor.getModel()!.getLineCount() + 1;

						const hiddenOriginalRange = r.getHiddenOriginalRange(reader);
						const hiddenModifiedRange = r.getHiddenModifiedRange(reader);

						if (hiddenOriginalRange.isEmpty) {
							continue;
						}

						store.add(new ActionsContentWidget(this._originalEditor, aOrig, hiddenOriginalRange.startLineNumber - 1, 30, constObservable<IContentWidgetAction[]>([
							{
								text: `${hiddenOriginalRange.length} Lines Hidden`
							},
							{
								text: '$(chevron-up) Show More',
								action() {
									r.showMoreAbove();
								},
							},
							{
								text: '$(chevron-down) Show More',
								action() {
									r.showMoreBelow();
								},
							},
							{
								text: '$(close) Show All',
								action() {

								},
							}
						]), unchangedRegionViewZoneIdsOrig, atTop, atBottom));

						store.add(new ActionsContentWidget(this._modifiedEditor, aMod, hiddenModifiedRange.startLineNumber - 1, 30, constObservable<IContentWidgetAction[]>([
							{
								text: `${r.modifiedRange.length} Lines Hidden`,
							},
							{
								text: '$(chevron-up) Show More',
								action() {

								},
							},
							{
								text: '$(chevron-down) Show More',
								action() {

								},
							},
							{
								text: '$(close) Show All',
								action() {

								},
							}
						]), unchangedRegionViewZoneIdsMod, atTop, atBottom));
					}
				});
			});

			this._originalEditor.setHiddenAreas(unchangedRegions.map(r => r.getHiddenOriginalRange(reader).toInclusiveRange()).filter(isDefined));
			this._modifiedEditor.setHiddenAreas(unchangedRegions.map(r => r.getHiddenModifiedRange(reader).toInclusiveRange()).filter(isDefined));
		}));

		// line heights

		let isChangingViewZones = false;

		const origViewZonesChanged = observableSignalFromEvent(
			'origViewZonesChanged',
			e => this._originalEditor.onDidChangeViewZones((args) => { if (!isChangingViewZones) { e(args); } })
		);
		const modViewZonesChanged = observableSignalFromEvent(
			'modViewZonesChanged',
			e => this._modifiedEditor.onDidChangeViewZones((args) => { if (!isChangingViewZones) { e(args); } })
		);

		const alignmentViewZoneIdsOrig = new Set<string>();
		const alignmentViewZoneIdsMod = new Set<string>();

		const alignments = derived<IRangeAlignment[] | null>('alignments', (reader) => {
			const diff = this._diffModel.read(reader)?.diff.read(reader);
			if (!diff) {
				return null;
			}

			origViewZonesChanged.read(reader);
			modViewZonesChanged.read(reader);

			return computeRangeAlignment(
				this._originalEditor,
				this._modifiedEditor,
				diff.changes,
				id => alignmentViewZoneIdsOrig.has(id),
				id => alignmentViewZoneIdsMod.has(id),
			);
		});


		function createFakeLinesDiv(): HTMLElement {
			const r = document.createElement('div');
			r.className = 'diagonal-fill';
			return r;
		}

		this._register(autorunWithStore2('alignment viewzones', (reader) => {
			isChangingViewZones = true;

			const alignments_ = alignments.read(reader);

			this._originalEditor.changeViewZones((aOrig) => {
				this._modifiedEditor.changeViewZones(aMod => {
					for (const id of alignmentViewZoneIdsOrig) {
						aOrig.removeZone(id);
					}
					alignmentViewZoneIdsOrig.clear();

					for (const id of alignmentViewZoneIdsMod) {
						aMod.removeZone(id);
					}
					alignmentViewZoneIdsMod.clear();


					if (!alignments_) {
						return;
					}

					for (const a of alignments_) {
						const delta = a.modifiedHeightInLines - a.originalHeightInLines;
						if (delta > 0) {
							alignmentViewZoneIdsOrig.add(aOrig.addZone({
								afterLineNumber: a.originalRange.endLineNumberExclusive - 1,
								domNode: createFakeLinesDiv(),
								heightInLines: delta,
							}));
						} else {
							alignmentViewZoneIdsMod.add(aMod.addZone({
								afterLineNumber: a.modifiedRange.endLineNumberExclusive - 1,
								domNode: createFakeLinesDiv(),
								heightInLines: -delta,
							}));
						}
					}
				});
			});

			isChangingViewZones = false;
		}));

		// overview ruler
		this._register(autorunWithStore2('update', (reader, store) => {
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

			store.add(autorunWithStore2('update', (reader, store) => {
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
					new OverviewRulerZone(0, 10, 0, Color.red.toString()),
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
			}));
		}));


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

	setBoundarySashes(sashes: IBoundarySashes): void {
		this._sash.setBoundarySashes(sashes);
	}

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

class ActionsContentWidget extends FixedZoneWidget {
	private readonly _domNode = h('div.diff-hidden-lines', [
		this.showTopZigZag ? h('div.top') : {},
		h('div.center@content'),
		this.showBottomZigZag ? h('div.bottom') : {},
	]);

	constructor(
		editor: ICodeEditor,
		viewZoneAccessor: IViewZoneChangeAccessor,
		afterLineNumber: number,
		height: number,

		items: IObservable<IContentWidgetAction[]>,
		viewZoneIdsToCleanUp: string[],
		public readonly showTopZigZag: boolean,
		public readonly showBottomZigZag: boolean,
	) {
		super(editor, viewZoneAccessor, afterLineNumber, height, viewZoneIdsToCleanUp);

		this.widgetDomNode.appendChild(this._domNode.root);


		this._register(autorun('update commands', (reader) => {
			const i = items.read(reader);
			this.setState(i);
		}));
	}

	private setState(items: IContentWidgetAction[]) {
		const children: HTMLElement[] = [];
		let isFirst = true;
		for (const item of items) {
			if (isFirst) {
				isFirst = false;
			} else {
				children.push($('span', undefined, '\u00a0|\u00a0'));
			}
			const title = renderLabelWithIcons(item.text);

			if (item.action) {
				children.push($('a', { title: item.tooltip, role: 'button', onclick: () => item.action!() }, ...title));
			} else {
				children.push($('span', { title: item.tooltip }, ...title));
			}
		}

		reset(this._domNode.content, ...children);
	}
}
