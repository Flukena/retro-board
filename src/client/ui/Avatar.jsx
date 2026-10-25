import React from 'react';
import { Crown } from 'lucide-react';
import { TOPBAR_ICON_SIZE_PX } from '../chrome/chrome-layout.js';
import { avatarInitial, hueFromId } from '../board/player-colors.js';
import './avatar.css';

export function Avatar({ id, name, crown, ring, small }) {
  const classes = ['rb-avatar', small && 'rb-avatar--small', ring && 'rb-avatar--ring'].filter(Boolean).join(' ');
  return (
    <div className={classes} style={{ '--rb-avatar-hue': hueFromId(id || 'x') }}>
      {avatarInitial(name)}
      {crown && <span className="rb-avatar__crown"><Crown size={TOPBAR_ICON_SIZE_PX.CROWN} /></span>}
    </div>
  );
}
