/* ==========================================================================
 * Holding page — served instead of the 3D experience while the portfolio is
 * being rebuilt (see HOLDING_PAGE in main.tsx). Plain React, no three.js in
 * the bundle, no scroll track, nothing loaded over the network.
 * ========================================================================== */

const EMAIL = 'reddy.gokul@gmail.com';
const GITHUB = 'https://github.com/GokulMV';

export function HoldingPage(): JSX.Element {
  return (
    <main className="holding">
      <div className="holding__card">
        <p className="holding__eyebrow">Gokul MV</p>
        <h1 className="holding__title">Senior backend engineer · Java · Spring Boot · Kafka · AWS</h1>
        <p className="holding__body">
          This site is being rebuilt. In the meantime, the fastest way to reach me is email, and my open-source work
          is on GitHub.
        </p>
        <p className="holding__links">
          <a href={`mailto:${EMAIL}`}>{EMAIL}</a>
          <span aria-hidden="true"> · </span>
          <a href={GITHUB} rel="me noopener" target="_blank">
            github.com/GokulMV
          </a>
        </p>
      </div>
    </main>
  );
}

export default HoldingPage;
