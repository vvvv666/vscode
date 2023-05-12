/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';

export const diffFullLineAddDecoration = ModelDecorationOptions.register({
	className: 'diff-line-add',
	description: 'diff-line-add',
	isWholeLine: true,
});

export const diffFullLineDeleteDecoration = ModelDecorationOptions.register({
	className: 'diff-line-delete',
	description: 'diff-line-delete',
	isWholeLine: true,
});


export const diffAddDecoration = ModelDecorationOptions.register({
	className: 'diff-add',
	description: 'diff-add',
});

export const diffDeleteDecoration = ModelDecorationOptions.register({
	className: 'diff-delete',
	description: 'diff-delete',
});
