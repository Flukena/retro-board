import { useId, useMemo, useState, useSyncExternalStore } from 'react';
import { createLockedRoomController } from './create-locked-room-controller.js';

const EMPTY_FORM = Object.freeze({ password: '', confirmation: '', acknowledged: false });

/** The state behind a create-locked-board form, shared by every place that offers one. */
export function useLockedRoomForm({ name, createBoard }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const controller = useMemo(() => createLockedRoomController(), []);
  const formId = useId();
  const { busy, failed } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const onSubmit = async (event) => {
    event.preventDefault();
    await controller.submit(form, { name, createBoard });
    setForm(EMPTY_FORM);
  };
  return { form, formId, busy, failed, onChange: (patch) => setForm({ ...form, ...patch }), onSubmit };
}
