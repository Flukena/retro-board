import React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../ui/UiPrimitives.jsx';
import { BUTTON_VARIANT } from '../ui/ui-variants.js';
import { t, useLang } from '../ui/i18n.js';
import SitePage, { SiteLinks } from '../app/SitePage.jsx';
import { useCreateBoard } from '../app/use-create-board.js';
import CreateBoardError from '../app/CreateBoardError.jsx';
import { starterFormat } from './starter-formats.js';

const ICON_SIZE_PX = 16;

function StartBoard({ format, id }) {
  const { creating, createError, createBoard } = useCreateBoard();
  const name = t(format.nameKey);
  return (
    <div className="rb-template__start">
      <Button variant={BUTTON_VARIANT.PRIMARY} onClick={() => createBoard({ name, starter: format.slug })}
        disabled={creating} aria-describedby={id}>
        <Plus size={ICON_SIZE_PX} aria-hidden="true" />
        {creating ? t('landing.create.creating') : t('tpl.start', { name })}
      </Button>
      <p id={id} className="rb-template__note">{t('tpl.startNote')}</p>
      <CreateBoardError error={createError} className="rb-template__error" />
    </div>
  );
}

export default function TemplatePage({ slug }) {
  useLang();
  const format = starterFormat(slug);
  return (
    <SitePage labelledBy="template-title" className="rb-template">
        <h1 id="template-title" className="rb-legal__title">{t(format.headingKey)}</h1>
        <p className="rb-template__lede">{t(format.ledeKey)}</p>
        <StartBoard format={format} id="template-start-note" />
        <section className="rb-legal__section" aria-labelledby="template-board">
          <h2 id="template-board">{t('tpl.section.board')}</h2>
          <ul className="rb-template__list">
            {format.columns.map((column) => (
              <li key={column.id}>
                {t(column.descKey)}
                <q className="rb-template__example">{t(column.exampleKey)}</q>
              </li>
            ))}
          </ul>
        </section>
        <section className="rb-legal__section" aria-labelledby="template-when">
          <h2 id="template-when">{t('tpl.section.when')}</h2>
          <p>{t(format.whenKey)}</p>
        </section>
        <section className="rb-legal__section" aria-labelledby="template-steps">
          <h2 id="template-steps">{t('tpl.section.steps')}</h2>
          <ol className="rb-template__list">
            {format.stepKeys.map((key) => <li key={key}>{t(key)}</li>)}
          </ol>
        </section>
        <section className="rb-legal__section" aria-labelledby="template-prompts">
          <h2 id="template-prompts">{t('tpl.section.prompts')}</h2>
          {format.columns.map((column) => (
            <div key={column.id}>
              <h3 className="rb-template__subhead">{t(column.zoneKey)}</h3>
              <ul className="rb-template__list">
                {column.promptKeys.map((key) => <li key={key}>{t(key)}</li>)}
              </ul>
            </div>
          ))}
        </section>
        <section className="rb-legal__section" aria-labelledby="template-more">
          <h2 id="template-more">{t('tpl.section.more')}</h2>
          <SiteLinks current={slug} />
        </section>
    </SitePage>
  );
}
