export type WorkspaceGroup = {
  label?: string;
  links: Array<readonly [href: string, title: string]>;
};

export function WorkspaceGroups({
  groups,
  isCurrent,
  idPrefix,
}: {
  groups: WorkspaceGroup[];
  isCurrent: (href: string) => boolean;
  idPrefix: string;
}) {
  return groups
    .filter(({ links }) => links.length > 0)
    .map(({ label, links }, index) => {
      const titleId = `${idPrefix}-${index}`;
      return (
        <div className="workspace-group" key={label ?? links[0]?.[0]}>
          {label ? (
            <p className="workspace-group-label" id={titleId}>
              {label}
            </p>
          ) : null}
          <ul aria-labelledby={label ? titleId : undefined}>
            {links.map(([href, title]) => (
              <li key={href}>
                <a href={href} aria-current={isCurrent(href) ? 'page' : undefined}>
                  {title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      );
    });
}
