import React from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { t, useLang } from '../ui/i18n.js';
import { LanguagePicker } from '../ui/LanguagePicker.jsx';
import { useTheme, nextThemePref } from '../ui/theme.js';
import { Button } from '../ui/UiPrimitives.jsx';
import AccountMenu from '../account/AccountMenu.jsx';
import { TOPBAR_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import './landing.css';

const BRAND_ICON_SIZE_PX = 22;
const THEME_ICONS = Object.freeze({ auto: Monitor, dark: Moon, light: Sun });

function CornerToggles() {
  const { pref: themePref, setThemePref } = useTheme();
  const ThemeIcon = THEME_ICONS[themePref];
  const themeTitle = `${t('settings.theme')}: ${t(`settings.theme.${themePref}`)}`;
  return (
    <div className="rb-landing__corner">
      <AccountMenu />
      <LanguagePicker />
      <Button
        className="rb-btn--pill"
        onClick={() => setThemePref(nextThemePref(themePref))}
        title={themeTitle}
        aria-label={themeTitle}
      >
        <ThemeIcon size={TOPBAR_ICON_SIZE_PX.TOGGLE} />
      </Button>
    </div>
  );
}

// Top bar of a product home page: brand, in-page links, an optional action
// (such as a link to the other tool) and the language/theme toggles.
// `links` is a list of { href, labelKey }.
export default function SiteMasthead({ homeHref, BrandIcon, titleKey, links, action = null }) {
  useLang();
  return (
    <header className="rb-landing__masthead">
      <a className="rb-landing__identity" href={homeHref}>
        <span className="rb-landing__brand"><BrandIcon size={BRAND_ICON_SIZE_PX} /></span>
        <span className="rb-landing__wordmark">{t(titleKey)}</span>
      </a>
      <nav className="rb-landing__nav" aria-label={t('tpl.linksNav')}>
        {links.map(({ href, labelKey }) => <a key={href} href={href}>{t(labelKey)}</a>)}
      </nav>
      {action}
      <CornerToggles />
    </header>
  );
}
