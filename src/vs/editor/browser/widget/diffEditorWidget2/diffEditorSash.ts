/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sash, Orientation, ISashEvent, IBoundarySashes } from 'vs/base/browser/ui/sash/sash';
import { Disposable } from 'vs/base/common/lifecycle';

export class DiffEditorSash extends Disposable {
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
