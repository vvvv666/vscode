/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, toDisposable } from 'vs/base/common/lifecycle';
import { IObservable, autorun } from 'vs/base/common/observable';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IModelDeltaDecoration } from 'vs/editor/common/model';
import { IDisposable } from 'xterm';

export function joinCombine<T>(arr1: readonly T[], arr2: readonly T[], keySelector: (val: T) => number, combine: (v1: T, v2: T) => T): readonly T[] {
	if (arr1.length === 0) {
		return arr2;
	}
	if (arr2.length === 0) {
		return arr1;
	}

	const result: T[] = [];
	let i = 0;
	let j = 0;
	while (i < arr1.length && j < arr2.length) {
		const val1 = arr1[i];
		const val2 = arr2[j];
		const key1 = keySelector(val1);
		const key2 = keySelector(val2);

		if (key1 < key2) {
			result.push(val1);
			i++;
		} else if (key1 > key2) {
			result.push(val2);
			j++;
		} else {
			result.push(combine(val1, val2));
			i++;
			j++;
		}
	}
	while (i < arr1.length) {
		result.push(arr1[i]);
		i++;
	}
	while (j < arr2.length) {
		result.push(arr2[j]);
		j++;
	}
	return result;
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

export function appendRemoveOnDispose(parent: HTMLElement, child: HTMLElement) {
	parent.appendChild(child);
	return toDisposable(() => {
		parent.removeChild(child);
	});
}


