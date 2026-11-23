const JSON_INDENT_SPACES = 2;
// Board and poker invite links carry a base64url capability in the fragment.
const ROOM_LINK = /(\/[bp]\/[\w-]+\/?(?:\?[^#\s"'<>\\]*)?)#[\w-]+/g;

export function redactRoomCapabilities(text) {
  return text.replace(ROOM_LINK, '$1');
}

export function formatLiveReport(report) {
  return redactRoomCapabilities(JSON.stringify(report, null, JSON_INDENT_SPACES));
}
