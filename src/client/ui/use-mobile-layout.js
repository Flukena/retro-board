import { useEffect, useState } from 'react';
import { MOBILE_LAYOUT_QUERY } from './mobile-layout.js';

/** True while the phone layout (narrow or coarse-pointer tablet) applies. */
export function useMobileLayout() {
  const [mobile, setMobile] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_QUERY).matches
  ));
  useEffect(() => {
    const query = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}
