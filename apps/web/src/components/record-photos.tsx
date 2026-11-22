'use client';

import { useId, useRef, useState } from 'react';

type Copy = {
  title: string;
  load: string;
  select: string;
  upload: string;
  uploaded: string;
  open: string;
  empty: string;
  failed: string;
  invalid: string;
};
export function RecordPhotos({
  endpoint,
  editable,
  copy,
}: {
  endpoint: string;
  editable: boolean;
  copy: Copy;
}) {
  const [photos, setPhotos] = useState<{ id: string }[] | null>(null);
  const [selected, setSelected] = useState<{ file: File; id: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  async function read() {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const result = (await response.json()) as { photos: { id: string }[] };
    setPhotos(result.photos);
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch {
      setMessage(copy.failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="section" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <div className="form-inline">
        <button className="button" type="button" onClick={() => void perform(read)} disabled={busy}>
          {copy.load}
        </button>
        {editable ? (
          <>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {copy.select}
            </button>
            <label className="visually-hidden" htmlFor={inputId}>
              {copy.select}
            </label>
            <input
              hidden
              ref={input}
              id={inputId}
              type="file"
              accept="image/jpeg,image/png"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (
                  !file.size ||
                  file.size > 5 * 1024 * 1024 ||
                  !['image/jpeg', 'image/png'].includes(file.type)
                ) {
                  setSelected(null);
                  setMessage(copy.invalid);
                  return;
                }
                setSelected({ file, id: crypto.randomUUID() });
                setMessage('');
              }}
            />
          </>
        ) : null}
      </div>
      {editable && selected ? (
        <div className="form-inline">
          <bdi>{selected.file.name}</bdi>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const response = await fetch(endpoint + '/' + selected.id, {
                  method: 'PUT',
                  headers: { 'content-type': selected.file.type },
                  body: selected.file,
                });
                if (!response.ok) throw new Error();
                setPhotos((current) =>
                  current?.some(({ id }) => id === selected.id)
                    ? current
                    : [...(current ?? []), { id: selected.id }],
                );
                setSelected(null);
                setMessage(copy.uploaded);
              })
            }
          >
            {copy.upload}
          </button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {photos?.length ? (
        <ul className="organisation-list">
          {photos.map(({ id }, index) => (
            <li key={id}>
              <a className="button" href={endpoint + '/' + id}>
                {copy.open} {index + 1}
              </a>
            </li>
          ))}
        </ul>
      ) : photos ? (
        <p>{copy.empty}</p>
      ) : null}
    </section>
  );
}
