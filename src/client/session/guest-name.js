const GUEST_NUMBER_MIN = 1000;
const GUEST_NUMBER_RANGE = 9000;
const GUEST_NAME_PREFIX = 'Guest-';

export const randomGuestName = (random) => (
  `${GUEST_NAME_PREFIX}${Math.floor(GUEST_NUMBER_MIN + random() * GUEST_NUMBER_RANGE)}`
);
