import React from 'react';
import { t } from '../ui/i18n.js';
import { formatRoomAge, formatRoomTime } from './monitoring-format.js';

export function RoomActivity({ room, now }) {
  return <td>
    <div>{t('maintainer.roomAge')}: {formatRoomAge(room.createdAt, now)}</div>
    <div>{t('maintainer.createdAt')}: {formatRoomTime(room.createdAt)}</div>
    <div>{t('maintainer.lastSessionAt')}: {formatRoomTime(room.lastSessionAt)}</div>
    <div>{t('maintainer.lastActiveAt')}: {room.connections > 0 ? t('maintainer.connectedNow') : formatRoomTime(room.lastActiveAt)}</div>
  </td>;
}
