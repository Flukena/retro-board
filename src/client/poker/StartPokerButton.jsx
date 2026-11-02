import React from 'react';
import { Spade } from 'lucide-react';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import { useCreateBoard } from '../app/use-create-board.js';
import CreateBoardError from '../app/CreateBoardError.jsx';
import { ROOM_KIND } from '../app/router.js';

const ICON_SIZE_PX = 16;

// Creates a relay room and opens it as a Planning Poker room.
export default function StartPokerButton({ describedBy, errorClassName, variant = BUTTON_VARIANT.PRIMARY }) {
  const { creating, createError, createBoard } = useCreateBoard();
  return (
    <>
      <Button variant={variant} disabled={creating} aria-describedby={describedBy}
        onClick={() => createBoard({ kind: ROOM_KIND.POKER })}>
        <Spade size={ICON_SIZE_PX} aria-hidden="true" />
        {creating ? t('landing.create.creating') : t('landing.poker.btn')}
      </Button>
      <CreateBoardError error={createError} className={errorClassName} />
    </>
  );
}
