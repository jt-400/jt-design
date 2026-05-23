/*
 * Sticky Header — static markup rendered at build time. Headroom-style
 * hide/show is attached by the tiny inline script in the page component.
 */

const SITE = 'https://tuatahi.art';
const REPO = 'https://tuatahi.art';
const REPO_RELEASES = `${SITE}/download`;
const REPO_SKILLS = `${SITE}/#skills`;
const REPO_DESIGN_SYSTEMS = `${SITE}/#systems`;

const ext = {
  target: '_blank',
  rel: 'noreferrer noopener',
} as const;

export function Header() {
  return (
    <header className='nav' data-od-id='nav' data-nav-headroom>
      <div className='container nav-inner'>
        <a href='#top' className='brand'>
          <span className='brand-mark' style={{ color: '#ff2d00', fontWeight: 800, fontSize: '1.1em', letterSpacing: '-0.02em' }}>JT</span>
          <span>JT Design</span>
          <span className='brand-meta'>
            <b>Studio Nº 01</b>Auckland / tuatahi.art
          </span>
        </a>
        <nav>
          <ul className='nav-links'>
            <li>
              <a href={REPO_SKILLS} {...ext}>
                Skills<span className='num'>31</span>
              </a>
            </li>
            <li>
              <a href={REPO_DESIGN_SYSTEMS} {...ext}>
                Systems<span className='num'>72</span>
              </a>
            </li>
            <li>
              <a href='#agents'>
                Agents<span className='num'>12</span>
              </a>
            </li>
            <li>
              <a href='#labs'>
                Labs<span className='num'>05</span>
              </a>
            </li>
            <li>
              <a href='#contact'>Contact</a>
            </li>
          </ul>
        </nav>
        <div className='nav-side'>
          <a
            className='nav-cta ghost'
            href={REPO_RELEASES}
            aria-label='Download JT Design desktop'
            title='Download the desktop app'
            {...ext}
          >
            Download
          </a>
          <a
            className='nav-cta'
            href={SITE}
            aria-label='Visit tuatahi.art'
            title='Visit tuatahi.art'
            {...ext}
          >
            tuatahi.art
          </a>
          <span className='status-dot' aria-hidden='true' />
        </div>
      </div>
    </header>
  );
}
