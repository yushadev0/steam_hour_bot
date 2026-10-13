/** Saat kadranı + Steam mavisi; favicon ile aynı işaret. */
export function Logo({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const icon = size === 'lg' ? 40 : 26;
  return (
    <div className="flex items-center gap-2.5">
      <svg width={icon} height={icon} viewBox="0 0 32 32" aria-hidden>
        <circle cx="16" cy="16" r="12" fill="none" stroke="#66c0f4" strokeWidth="2.5" />
        <path d="M16 9v7l4.5 3" fill="none" stroke="#90ba3c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className={`leading-none font-semibold text-bright ${size === 'lg' ? 'text-2xl' : 'text-base'}`}>
        yusha's <span className="font-normal text-muted">Steam Hour Bot</span>
      </span>
    </div>
  );
}
