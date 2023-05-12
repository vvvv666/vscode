/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ArrayQueue } from 'vs/base/common/arrays';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { joinCombine } from 'vs/editor/browser/widget/diffEditorWidget2/utils';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { LineRange } from 'vs/editor/common/core/lineRange';
import { Position } from 'vs/editor/common/core/position';
import { LineRangeMapping } from 'vs/editor/common/diff/linesDiffComputer';

interface AdditionalLineHeightInfo {
	lineNumber: number;
	heightInLines: number;
}

export function getAdditionalLineHeights(editor: CodeEditorWidget, shouldIgnoreViewZone: (id: string) => boolean): readonly AdditionalLineHeightInfo[] {
	const lineHeight = editor.getOption(EditorOption.lineHeight);
	const viewZoneHeights: { lineNumber: number; heightInLines: number }[] = [];
	const wrappingZoneHeights: { lineNumber: number; heightInLines: number }[] = [];

	const hasWrapping = editor.getOption(EditorOption.wrappingInfo).wrappingColumn !== -1;
	const coordinatesConverter = editor._getViewModel()!.coordinatesConverter;
	if (hasWrapping) {
		for (let i = 1; i <= editor.getModel()!.getLineCount(); i++) {
			const lineCount = coordinatesConverter.getModelLineViewLineCount(i);
			if (lineCount > 1) {
				wrappingZoneHeights.push({ lineNumber: i, heightInLines: lineCount - 1 });
			}
		}
	}

	for (const w of editor.getWhitespaces()) {
		if (shouldIgnoreViewZone(w.id)) {
			continue;
		}
		const modelLineNumber = coordinatesConverter.convertViewPositionToModelPosition(
			new Position(w.afterLineNumber, 1)
		).lineNumber;
		viewZoneHeights.push({ lineNumber: modelLineNumber, heightInLines: w.height / lineHeight });
	}

	const result = joinCombine(
		viewZoneHeights,
		wrappingZoneHeights,
		v => v.lineNumber,
		(v1, v2) => ({ lineNumber: v1.lineNumber, heightInLines: v1.heightInLines + v2.heightInLines })
	);

	return result;
}

export interface IRangeAlignment {
	originalRange: LineRange;
	modifiedRange: LineRange;

	// accounts for foreign viewzones and line wrapping
	originalHeightInLines: number;
	modifiedHeightInLines: number;
}

export function computeRangeAlignment(
	originalEditor: CodeEditorWidget,
	modifiedEditor: CodeEditorWidget,
	diffs: LineRangeMapping[],
	originalEditorIsAlignmentViewZone: (id: string) => boolean,
	modifiedEditorIsAlignmentViewZone: (id: string) => boolean,
): IRangeAlignment[] {
	const originalLineHeightOverrides = new ArrayQueue(getAdditionalLineHeights(originalEditor, originalEditorIsAlignmentViewZone));
	const modifiedLineHeightOverrides = new ArrayQueue(getAdditionalLineHeights(modifiedEditor, modifiedEditorIsAlignmentViewZone));

	const result: IRangeAlignment[] = [];

	let lastOriginalLineNumber = 0;
	let lastModifiedLineNumber = 0;

	function handleAlignmentsOutsideOfDiffs(untilOriginalLineNumberExclusive: number, untilModifiedLineNumberExclusive: number) {
		while (true) {
			let origNext = originalLineHeightOverrides.peek();
			let modNext = modifiedLineHeightOverrides.peek();
			if (origNext && origNext.lineNumber >= untilOriginalLineNumberExclusive) {
				origNext = undefined;
			}
			if (modNext && modNext.lineNumber >= untilModifiedLineNumberExclusive) {
				modNext = undefined;
			}
			if (!origNext && !modNext) {
				break;
			}

			const distOrig = origNext ? origNext.lineNumber - lastOriginalLineNumber : Number.MAX_VALUE;
			const distNext = modNext ? modNext.lineNumber - lastModifiedLineNumber : Number.MAX_VALUE;

			if (distOrig < distNext) {
				originalLineHeightOverrides.dequeue();
				modNext = {
					lineNumber: origNext!.lineNumber - lastOriginalLineNumber + lastModifiedLineNumber,
					heightInLines: 0,
				};
			} else if (distOrig > distNext) {
				modifiedLineHeightOverrides.dequeue();
				origNext = {
					lineNumber: modNext!.lineNumber - lastModifiedLineNumber + lastOriginalLineNumber,
					heightInLines: 0,
				};
			} else {
				originalLineHeightOverrides.dequeue();
				modifiedLineHeightOverrides.dequeue();
			}

			result.push({
				originalRange: LineRange.ofLength(origNext!.lineNumber, 1),
				modifiedRange: LineRange.ofLength(modNext!.lineNumber, 1),
				originalHeightInLines: 1 + origNext!.heightInLines,
				modifiedHeightInLines: 1 + modNext!.heightInLines,
			});
		}
	}

	for (const c of diffs) {
		handleAlignmentsOutsideOfDiffs(c.originalRange.startLineNumber, c.modifiedRange.startLineNumber);

		const originalAdditionalHeight = originalLineHeightOverrides
			.takeWhile(v => v.lineNumber < c.originalRange.endLineNumberExclusive)
			?.reduce((p, c) => p + c.heightInLines, 0) ?? 0;
		const modifiedAdditionalHeight = modifiedLineHeightOverrides
			.takeWhile(v => v.lineNumber < c.modifiedRange.endLineNumberExclusive)
			?.reduce((p, c) => p + c.heightInLines, 0) ?? 0;

		result.push({
			originalRange: c.originalRange,
			modifiedRange: c.modifiedRange,
			originalHeightInLines: c.originalRange.length + originalAdditionalHeight,
			modifiedHeightInLines: c.modifiedRange.length + modifiedAdditionalHeight,
		});

		lastOriginalLineNumber = c.originalRange.endLineNumberExclusive;
		lastModifiedLineNumber = c.modifiedRange.endLineNumberExclusive;
	}
	handleAlignmentsOutsideOfDiffs(Number.MAX_VALUE, Number.MAX_VALUE);

	return result;
}
