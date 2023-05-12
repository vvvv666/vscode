/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, toDisposable } from 'vs/base/common/lifecycle';
import { IObservable, IObserver, IReader, autorunWithStore, observableFromEvent, observableSignalFromEvent, observableValue, transaction } from 'vs/base/common/observable';
import { IDiffEditorModel } from 'vs/editor/common/editorCommon';
import { IDocumentDiff, IDocumentDiffProvider } from 'vs/editor/common/diff/documentDiffProvider';
import { timeout } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { LineRange } from 'vs/editor/common/core/lineRange';
import { LineRangeMapping } from 'vs/editor/common/diff/linesDiffComputer';

export class DiffModel extends Disposable {
	private readonly _isDiffUpToDate = observableValue<boolean>('isDiffUpToDate', false);
	public readonly isDiffUpToDate: IObservable<boolean> = this._isDiffUpToDate;

	private readonly _diff = observableValue<IDocumentDiff | undefined>('diff', undefined);
	public readonly diff: IObservable<IDocumentDiff | undefined> = this._diff;


	private readonly _unchangedRegion = observableValue<UnchangedRegion[]>('unchangedRegion', []);
	public readonly unchangedRegions: IObservable<UnchangedRegion[]> = this._unchangedRegion;

	constructor(
		private readonly _model: IDiffEditorModel,
		ignoreTrimWhitespace: IObservable<boolean>,
		maxComputationTimeMs: IObservable<number>,
		documentDiffProvider: IDocumentDiffProvider
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

					this._unchangedRegion.set(
						UnchangedRegion.fromDiffs(result.changes, _model.original.getLineCount(), _model.modified.getLineCount()),
						tx
					);
				});

			});
		}, 'compute diff'));
	}
}

export class UnchangedRegion {
	public static fromDiffs(changes: LineRangeMapping[], originalLineCount: number, modifiedLineCount: number): UnchangedRegion[] {
		const inversedMappings = LineRangeMapping.inverse(changes, originalLineCount, modifiedLineCount);
		const result: UnchangedRegion[] = [];

		const minHiddenLineCount = 3;
		const minContext = 3;

		for (const mapping of inversedMappings) {
			let origStart = mapping.originalRange.startLineNumber;
			let modStart = mapping.modifiedRange.startLineNumber;
			let length = mapping.originalRange.length;

			if (origStart === 1 && length > minContext + minHiddenLineCount) {
				length -= minContext;
				result.push(new UnchangedRegion(origStart, modStart, length, 0, 0));
			} else if (origStart + length === originalLineCount + 1 && length > minContext + minHiddenLineCount) {
				origStart += minContext;
				modStart += minContext;
				length -= minContext;
				result.push(new UnchangedRegion(origStart, modStart, length, 0, 0));
			} else if (length > minContext * 2 + minHiddenLineCount) {
				origStart += minContext;
				modStart += minContext;
				length -= minContext * 2;
				result.push(new UnchangedRegion(origStart, modStart, length, 0, 0));
			}
		}

		return result;
	}

	public get originalRange(): LineRange {
		return LineRange.ofLength(this.originalLineNumber, this.lineCount);
	}

	public get modifiedRange(): LineRange {
		return LineRange.ofLength(this.modifiedLineNumber, this.lineCount);
	}

	private _visibleLineCountTop = observableValue<number>('visibleLineCountTop', 0);
	public visibleLineCountTop: IObservable<number> = this._visibleLineCountTop;

	private _visibleLineCountBottom = observableValue<number>('visibleLineCountBottom', 0);
	public visibleLineCountBottom: IObservable<number> = this._visibleLineCountBottom;

	constructor(
		public readonly originalLineNumber: number,
		public readonly modifiedLineNumber: number,
		public readonly lineCount: number,
		visibleLineCountTop: number,
		visibleLineCountBottom: number,

	) {
		this._visibleLineCountTop.set(visibleLineCountTop, undefined);
		this._visibleLineCountBottom.set(visibleLineCountBottom, undefined);
	}

	public getHiddenOriginalRange(reader: IReader): LineRange {
		return LineRange.ofLength(
			this.originalLineNumber + this._visibleLineCountTop.read(reader),
			this.lineCount - this._visibleLineCountTop.read(reader) - this._visibleLineCountBottom.read(reader),
		);
	}

	public getHiddenModifiedRange(reader: IReader): LineRange {
		return LineRange.ofLength(
			this.modifiedLineNumber + this._visibleLineCountTop.read(reader),
			this.lineCount - this._visibleLineCountTop.read(reader) - this._visibleLineCountBottom.read(reader),
		);
	}

	public showMoreAbove(): void {
		const maxVisibleLineCountTop = this.lineCount - this._visibleLineCountBottom.get();
		this._visibleLineCountTop.set(Math.min(this._visibleLineCountTop.get() + 10, maxVisibleLineCountTop), undefined);
	}

	public showMoreBelow(): void {
		const maxVisibleLineCountBottom = this.lineCount - this._visibleLineCountTop.get();
		this._visibleLineCountBottom.set(Math.min(this._visibleLineCountBottom.get() + 10, maxVisibleLineCountBottom), undefined);
	}

	public showAll(): void {
		this._visibleLineCountBottom.set(this.lineCount - this._visibleLineCountTop.get(), undefined);
	}
}
