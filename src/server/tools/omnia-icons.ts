/**
 * OmnIA Icons & Brand Assets
 * 
 * Provides dark and light SVG assets for the OmnIA Tool Suite.
 * - Dark logo (dark elements on transparent background, optimal for light theme)
 * - Light logo (light elements on transparent background, optimal for dark theme)
 */

export const OMNIA_LOGO_DARK_SVG = `<svg width="210mm" height="210mm" viewBox="0 0 210 210" version="1.1" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(237.9929)">
    <g transform="matrix(1.2926338,0,0,1.295241,38.918301,-31.000243)">
      <path style="fill:#d97706;fill-opacity:1" d="m -160.99224,178.37877 29.42353,-29.42352 h -45.38069 v -45.43806 l -29.42146,29.42146 v 45.44012 z" />
      <path style="fill:#3f3f46;fill-opacity:1" d="M -59.615481,97.965077 -89.03694,127.38654 v 12.53153 0.0977 c 0,5.20781 -3.73347,8.93951 -8.941573,8.93951 h -12.626617 l -29.42353,29.42352 h 42.050147 c 20.998845,0 38.363032,-17.36387 38.363032,-38.36303 v -0.0977 z" />
      <path style="fill:#d97706;fill-opacity:1" d="m -105.05302,31.620808 -29.42404,29.424043 h 45.44012 V 106.42348 L -59.615481,77.002016 V 31.620808 Z" />
      <path style="fill:#3f3f46;fill-opacity:1" d="m -126.01711,31.621325 h -41.99072 c -20.99916,0 -38.36303,17.365947 -38.36303,38.365099 v 0.0956 41.893046 l 29.42146,-29.421457 v -12.471589 -0.0956 c 0,-5.207798 3.73377,-8.941573 8.94157,-8.941573 h 12.56719 z" />
    </g>
  </g>
</svg>`;

export const OMNIA_LOGO_LIGHT_SVG = `<svg width="210mm" height="210mm" viewBox="0 0 210 210" version="1.1" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(237.9929,-239.53548)">
    <path style="fill:#d97706;fill-opacity:1;stroke-width:1.29394" d="m -169.18571,439.57884 38.03385,-38.11055 h -58.66061 v -58.85324 l -38.03118,38.10788 v 58.85591 z" />
    <path style="fill:#e5e7eb;fill-opacity:1;stroke-width:1.29394" d="m -38.142685,335.42372 -38.031172,38.10789 v 16.23135 0.12655 c 0,6.74536 -4.82601,11.57882 -11.55818,11.57882 h -16.321593 l -38.03385,38.11055 h 54.355443 c 27.143817,0 49.589352,-22.4904 49.589352,-49.68937 v -0.12655 z" />
    <path style="fill:#d97706;fill-opacity:1;stroke-width:1.29394" d="m -96.876783,249.49191 -38.034507,38.11122 h 58.737433 v 58.77626 l 38.031172,-38.10788 v -58.7796 z" />
    <path style="fill:#e5e7eb;fill-opacity:1;stroke-width:1.29394" d="m -123.97567,249.49258 h -54.27863 c -27.14422,0 -49.58935,22.49308 -49.58935,49.69205 v 0.12382 54.26159 l 38.03118,-38.10788 v -16.15371 -0.12382 c 0,-6.74536 4.82639,-11.5815 11.55817,-11.5815 h 16.24478 z" />
  </g>
</svg>`;

export const OMNIA_LOGO_DARK_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(OMNIA_LOGO_DARK_SVG).toString("base64")}`;
export const OMNIA_LOGO_LIGHT_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(OMNIA_LOGO_LIGHT_SVG).toString("base64")}`;
