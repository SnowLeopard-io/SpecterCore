import { useMemo, useState } from 'react';

const SIZE = 9;
const MINES = 10;

interface Cell {
  mine: boolean;
  revealed: boolean;
  flagged: boolean;
  adjacent: number;
}

function createBoard(): Cell[][] {
  const cells: Cell[][] = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => ({ mine: false, revealed: false, flagged: false, adjacent: 0 })),
  );
  let placed = 0;
  while (placed < MINES) {
    const r = Math.floor(Math.random() * SIZE);
    const c = Math.floor(Math.random() * SIZE);
    if (!cells[r]![c]!.mine) {
      cells[r]![c]!.mine = true;
      placed += 1;
    }
  }
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (cells[r + dr]?.[c + dc]?.mine) n += 1;
        }
      }
      cells[r]![c]!.adjacent = n;
    }
  }
  return cells;
}

function reveal(cells: Cell[][], r: number, c: number): void {
  const cell = cells[r]?.[c];
  if (!cell || cell.revealed || cell.flagged) return;
  cell.revealed = true;
  if (cell.adjacent === 0 && !cell.mine) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        reveal(cells, r + dr, c + dc);
      }
    }
  }
}

/** Classic Minesweeper demo app. */
export function MinesweeperApp() {
  const [board, setBoard] = useState(() => createBoard());
  const [exploded, setExploded] = useState(false);

  const remaining = useMemo(() => {
    let hidden = 0;
    for (const row of board) for (const cell of row) if (!cell.revealed && !cell.flagged) hidden += 1;
    return hidden;
  }, [board]);

  const onCell = (r: number, c: number): void => {
    if (exploded) return;
    setBoard((prev) => {
      const next = prev.map((row) => row.map((cell) => ({ ...cell })));
      const cell = next[r]![c]!;
      if (cell.flagged) return prev;
      if (cell.mine) {
        setExploded(true);
        return next;
      }
      reveal(next, r, c);
      return next;
    });
  };

  const onFlag = (r: number, c: number): void => {
    if (exploded) return;
    setBoard((prev) => {
      const next = prev.map((row) => row.map((cell) => ({ ...cell })));
      const cell = next[r]![c]!;
      if (!cell.revealed) cell.flagged = !cell.flagged;
      return next;
    });
  };

  const reset = (): void => {
    setExploded(false);
    setBoard(createBoard());
  };

  return (
    <div className="bk-app-body bk-mines">
      <div className="bk-mines-header">
        <span>Mines: {MINES}</span>
        <button onClick={reset}>New</button>
        <span>Hidden: {remaining}</span>
      </div>
      <div className="bk-mines-grid" style={{ gridTemplateColumns: `repeat(${SIZE}, 28px)` }}>
        {board.map((row, r) =>
          row.map((cell, c) => (
            <button
              key={`${r}-${c}`}
              className={`bk-mines-cell ${cell.revealed ? 'revealed' : ''} ${cell.mine && cell.revealed ? 'mine' : ''}`}
              onClick={() => onCell(r, c)}
              onContextMenu={(e) => {
                e.preventDefault();
                onFlag(r, c);
              }}
            >
              {cell.flagged && 'F'}
              {cell.revealed && !cell.mine && cell.adjacent > 0 && cell.adjacent}
              {cell.revealed && cell.mine && '*'}
            </button>
          )),
        )}
      </div>
    </div>
  );
}