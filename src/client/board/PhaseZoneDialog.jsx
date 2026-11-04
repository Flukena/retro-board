import React from 'react';
import { LayoutGrid, Milestone, SquareDashed } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell.jsx';
import { MODAL_SIZE } from '../ui/ui-variants.js';
import { t } from '../ui/i18n.js';
import './phase-bar.css';

const TITLE_ICON_SIZE_PX = 22;
const CHOICE_ICON_SIZE_PX = 18;

function ZoneChoice({ icon, title, detail, onClick }) {
  return (
    <li>
      <button type="button" className="rb-phase-choice" onClick={onClick}>
        {icon}
        <span className="rb-phase-choice__title">{title}</span>
        <span className="rb-phase-choice__detail">{detail}</span>
      </button>
    </li>
  );
}

/** The admin picks the top-level zone the meeting runs on, or the whole board. */
export function PhaseZoneDialog({ choices, onPick, onCancel }) {
  return (
    <ModalShell size={MODAL_SIZE.MD} labelledBy="phase-zone-dialog-title" onDismiss={onCancel}>
      <div className="rb-dialog__header">
        <div className="rb-dialog__heading">
          <Milestone size={TITLE_ICON_SIZE_PX} color="var(--accent)" />
          <div id="phase-zone-dialog-title" className="rb-dialog__title">{t('phase.chooseTitle')}</div>
        </div>
      </div>
      <p className="rb-phase-choice-hint">{t('phase.chooseHint')}</p>
      <ul className="rb-phase-choices">
        {choices.map((zone) => (
          <ZoneChoice key={zone.id} icon={<SquareDashed size={CHOICE_ICON_SIZE_PX} />}
            title={zone.title || t('export.csv.untitledZone')} detail={t('phase.zoneCards', { n: zone.cardCount })}
            onClick={() => onPick(zone.id)} />
        ))}
        <ZoneChoice icon={<LayoutGrid size={CHOICE_ICON_SIZE_PX} />} title={t('phase.wholeBoard')}
          detail={t('phase.wholeBoardHint')} onClick={() => onPick(null)} />
      </ul>
    </ModalShell>
  );
}
