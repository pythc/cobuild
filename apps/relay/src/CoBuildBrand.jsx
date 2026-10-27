import { useState } from 'react';
import classes from './cobuild-brand.module.css';

/** A shared suite entry; the application keeps its own identity beside it. */
export function CoBuildBrand({ children }) {
  const [preserveAppFocus, setPreserveAppFocus] = useState(false);

  return (
    <div
      className={classes.identity}
      data-preserve-app-focus={preserveAppFocus || undefined}
      onKeyDownCapture={(event) => {
        if (event.key === 'Tab') setPreserveAppFocus(true);
      }}
      onPointerDownCapture={() => setPreserveAppFocus(false)}
    >
      <div className={classes.slot}>
        <a
          href="https://cobuild.110-lab.cn/"
          aria-label="CoBuild 首页"
          className={classes.link}
          data-cobuild-brand
          onPointerMove={() => {
            if (preserveAppFocus) setPreserveAppFocus(false);
          }}
        >
          <span className={classes.initial} aria-hidden="true" />
          <span className={classes.wordmark} aria-hidden="true" />
        </a>
      </div>
      <span className={classes.divider} aria-hidden="true" />
      <div className={classes.application}>{children}</div>
    </div>
  );
}
