// ---------------------------------------------------------------------------
// Hand-rolled inline SVG icon set (stroke = currentColor, 24x24 viewBox).
// No external icon package — keep this file self-contained.
// ---------------------------------------------------------------------------
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function createIcon(children: ReactNode, filled = false) {
  const Icon = (props: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
  return Icon;
}

// --- Navigation -------------------------------------------------------------
export const IconDashboard = createIcon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
);

export const IconUsers = createIcon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
  </>,
);

export const IconMic = createIcon(
  <>
    <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </>,
);

export const IconGift = createIcon(
  <>
    <path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9z" />
    <path d="M3 7.5h18V11H3z" />
    <path d="M12 7.5V21" />
    <path d="M12 7.5C11 4.5 9.8 3.5 8.4 3.5a2.1 2.1 0 0 0 0 4h3.6zm0 0c1-3 2.2-4 3.6-4a2.1 2.1 0 0 1 0 4H12z" />
  </>,
);

export const IconWallet = createIcon(
  <>
    <rect x="3" y="6" width="18" height="14" rx="2.5" />
    <path d="M3 10h18" />
    <circle cx="16.5" cy="15" r="1.2" />
  </>,
);

// --- Actions ------------------------------------------------------------------
export const IconSearch = createIcon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M16.5 16.5 21 21" />
  </>,
);

export const IconPlus = createIcon(<path d="M12 5v14M5 12h14" />);

export const IconEdit = createIcon(
  <>
    <path d="M4 20h4L20 8l-4-4L4 16v4z" />
    <path d="M13.5 6.5 17.5 10.5" />
  </>,
);

export const IconTrash = createIcon(
  <>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </>,
);

export const IconBan = createIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 18.4 18.4 5.6" />
  </>,
);

export const IconCheck = createIcon(<path d="M5 13l4 4 10-10" />);

export const IconShieldCheck = createIcon(
  <>
    <path d="M12 3l7 3v5c0 4.4-3 8.2-7 9.5-4-1.3-7-5.1-7-9.5V6l7-3z" />
    <path d="M9 11.5l2.2 2.2 4-4" />
  </>,
);

export const IconClose = createIcon(<path d="M6 6l12 12M18 6 6 18" />);

export const IconLogout = createIcon(
  <>
    <path d="M15 17l5-5-5-5" />
    <path d="M20 12H9" />
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6" />
  </>,
);

export const IconEye = createIcon(
  <>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const IconPlugUnplug = createIcon(
  <>
    <path d="M8.5 4.5v5M15.5 4.5v5" />
    <path d="M6 9.5h12v2.5a6 6 0 0 1-12 0v-2.5z" />
    <path d="M12 18v3" />
  </>,
);

export const IconChevronDown = createIcon(<path d="M6 9l6 6 6-6" />);
export const IconChevronLeft = createIcon(<path d="M14 6l-6 6 6 6" />);
export const IconChevronRight = createIcon(<path d="M10 6l6 6-6 6" />);

export const IconSidebarToggle = createIcon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);

export const IconPlay = createIcon(<path d="M8 5.5v13l11-6.5-11-6.5z" />, true);
export const IconPause = createIcon(
  <>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </>,
  true,
);

export const IconRefresh = createIcon(
  <>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <path d="M20 3.5V9h-5.5" />
  </>,
);

export const IconAlert = createIcon(
  <>
    <path d="M12 3.5 21.5 20h-19L12 3.5z" />
    <path d="M12 10v4" />
    <path d="M12 17.2v.1" />
  </>,
);

// --- Currencies / metrics -------------------------------------------------------
export const IconDiamond = createIcon(
  <>
    <path d="M7 4h10l4 5.5L12 21 3 9.5 7 4z" />
    <path d="M3 9.5h18" />
    <path d="M9.5 4 8 9.5l4 11.5 4-11.5L14.5 4" />
  </>,
);

export const IconCoin = createIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
  </>,
);

export const IconSpark = createIcon(
  <>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
    <path d="M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" />
  </>,
);

export const IconGiftSent = IconGift;

export const IconTrendUp = createIcon(
  <>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </>,
);

export const IconLiveDot = createIcon(<circle cx="12" cy="12" r="5" />, true);

export const IconRoomEmpty = createIcon(
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M8 21h8" />
  </>,
);

// --- Back-office sections ----------------------------------------------------
/** A die: the games console. */
export const IconGame = createIcon(
  <>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </>,
);

/** A badge on a lanyard: BD representatives and coin sellers. */
export const IconPartners = createIcon(
  <>
    <rect x="4" y="7" width="16" height="13" rx="2.5" />
    <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
    <path d="M8.5 13h7M8.5 16.5h4.5" />
  </>,
);

/** Money going out to a customer: recharge orders. */
export const IconRecharge = createIcon(
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <circle cx="12" cy="12" r="2.8" />
    <path d="M6 9.5v5M18 9.5v5" />
  </>,
);

/** A percentage in a box: commission rules and settlements. */
export const IconCommission = createIcon(
  <>
    <rect x="3" y="3" width="18" height="18" rx="3.5" />
    <path d="M8.5 15.5l7-7" />
    <circle cx="9.5" cy="9.5" r="1.6" />
    <circle cx="14.5" cy="14.5" r="1.6" />
  </>,
);

/** An open ledger: the double-entry book. */
export const IconBook = createIcon(
  <>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5A1.5 1.5 0 0 0 20 18.5z" />
  </>,
);

/** A checklist on a page: the audit trail. */
export const IconAudit = createIcon(
  <>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5" />
    <path d="M9 12.5l1.7 1.7L14 11M9 17l1.7 1.7L14 15.5" />
  </>,
);

/** Download arrow into a tray: report exports. */
export const IconDownload = createIcon(
  <>
    <path d="M12 3v11" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M4 19h16" />
  </>,
);

/** A balance: what a territory owes and what was paid against it. */
export const IconScales = createIcon(
  <>
    <path d="M12 4v16M7 20h10" />
    <path d="M4 9l3-4 3 4a3 3 0 0 1-6 0z" transform="translate(0 1)" />
    <path d="M14 9l3-4 3 4a3 3 0 0 1-6 0z" transform="translate(0 1)" />
  </>,
);

/** A key on a ring: credentials an operator can reset but never read. */
export const IconKey = createIcon(
  <>
    <circle cx="7.5" cy="12" r="3.5" />
    <path d="M11 12h9M17 12v3.5M14.5 12v2.5" />
  </>,
);

/** Sliders: the system switches that change what money means. */
export const IconSliders = createIcon(
  <>
    <path d="M4 7h16M4 12h16M4 17h16" />
    <circle cx="9" cy="7" r="2.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none" />
    <circle cx="11" cy="17" r="2.2" fill="currentColor" stroke="none" />
  </>,
);

/** Reorder arrows: moving a commission kind earlier or later in the calculation order. */
export const IconArrowUp = createIcon(
  <>
    <path d="M12 19V6" />
    <path d="M6.5 11.5L12 6l5.5 5.5" />
  </>,
);

export const IconArrowDown = createIcon(
  <>
    <path d="M12 5v13" />
    <path d="M6.5 12.5L12 18l5.5-5.5" />
  </>,
);
