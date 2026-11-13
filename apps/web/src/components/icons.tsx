// Decorative line icons. Every icon is hidden from assistive technology: the words beside it carry the meaning.
const paths = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  box: (
    <>
      <path d="M3 8l9-4 9 4v8l-9 4-9-4z" />
      <path d="M3 8l9 4 9-4" />
      <path d="M12 12v8" />
    </>
  ),
  truck: (
    <>
      <path d="M2 7h11v9H2z" />
      <path d="M13 10h4l4 3v3h-8z" />
      <circle cx="6.5" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="14" r="4" />
      <path d="M11 11l9-9" />
      <path d="M16 6l3 3" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
