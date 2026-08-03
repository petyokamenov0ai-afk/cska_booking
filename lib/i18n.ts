/**
 * Tiny i18n. Plain nested dictionaries, dot-path keys, `{var}` interpolation.
 *
 * Contract (docs/API_CONTRACT.md § lib/i18n.ts):
 *   type Locale = 'bg' | 'en'
 *   DEFAULT_LOCALE: Locale
 *   t(locale, key, vars?) => string
 *
 * The drawing is bilingual (Cyrillic + Latin), so bg is primary and en is the
 * fallback. Unknown keys return the key itself — visible in the UI, which is
 * exactly what you want while building.
 */

export type Locale = 'bg' | 'en';

export const LOCALES: readonly Locale[] = ['bg', 'en'] as const;

export function isLocale(value: unknown): value is Locale {
  return value === 'bg' || value === 'en';
}

const envLocale = process.env.NEXT_PUBLIC_DEFAULT_LOCALE;

export const DEFAULT_LOCALE: Locale = isLocale(envLocale) ? envLocale : 'bg';

interface Dictionary {
  [key: string]: string | Dictionary;
}

const bg: Dictionary = {
  brand: {
    name: 'ЦСКА',
    stadium: 'Стадион „Българска армия“',
    tagline: 'Резервация на места',
  },
  nav: {
    home: 'Начало',
    events: 'Мачове',
    overview: 'Общ изглед',
    myReservation: 'Моята резервация',
    language: 'Език',
    back: 'Назад',
    backToOverview: 'Към общия изглед',
    backToSector: 'Към сектор {code}',
  },
  common: {
    loading: 'Зареждане…',
    error: 'Възникна грешка',
    retry: 'Опитай отново',
    close: 'Затвори',
    cancel: 'Отказ',
    continue: 'Продължи',
    confirm: 'Потвърди',
    save: 'Запази',
    next: 'Напред',
    free: 'свободни',
    taken: 'заети',
    total: 'Общо',
    from: 'от',
    seats: 'места',
    seat: 'място',
    row: 'ред',
    yes: 'Да',
    no: 'Не',
    copy: 'Копирай',
    copied: 'Копирано',
    notFound: 'Не е намерено',
    optional: 'по желание',
    required: 'задължително',
  },
  events: {
    title: 'Предстоящи мачове',
    empty: 'В момента няма мачове в продажба.',
    kickoff: 'Начален час',
    salesOpen: 'Продажбите започват',
    salesClose: 'Продажбите приключват',
    selectSeats: 'Избери места',
    soldOut: 'Изчерпани',
    status: {
      DRAFT: 'Предстои',
      ON_SALE: 'В продажба',
      CLOSED: 'Затворен',
    },
  },
  sector: {
    label: 'Сектор {code}',
    'А': { name: 'Юг', latin: 'A' },
    'Б': { name: 'Изток', latin: 'B' },
    'В': { name: 'Север', latin: 'V' },
    'Г': { name: 'Запад', latin: 'G' },
  },
  subsector: {
    label: 'Подсектор {code}',
    // A shape the map draws whole over several bookable blocks — the caption
    // code is one of them, so the members have to be spelled out or a screen
    // reader hears a block that is not where activating it goes.
    group: '{code} · {count} блока: {members}',
    groupHint: 'Избери блок от списъка отдолу.',
    partOf: 'част от {code}',
    seatsFree: '{free} от {total} свободни',
    soldOut: 'Изчерпан',
  },
  map: {
    overviewTitle: 'Избери сектор',
    overviewHint: 'Докосни сектор, за да го увеличиш.',
    sectorHint: 'Избери подсектор.',
    seatMapHint: 'Приближи, за да избираш места.',
    zoomIn: 'Приближи',
    zoomOut: 'Отдалечи',
    zoomReset: 'Нулирай изгледа',
    pitch: 'Терен',
    rowLabel: 'Ред {row}',
    seatTooltip: 'Ред {row} · Място {number}',
    availability: {
      title: 'Наличност',
      high: 'Много свободни',
      medium: 'Ограничено',
      low: 'Почти изчерпан',
      none: 'Изчерпан',
    },
    legend: {
      title: 'Легенда',
      stands: 'Сектори',
    },
  },
  seat: {
    state: {
      FREE: 'Свободно',
      SELECTED: 'Избрано',
      HELD: 'Задържано',
      RESERVED: 'Резервирано',
      BLOCKED: 'Недостъпно',
      MINE: 'Твое задържано',
    },
    type: {
      STANDARD: 'Стандартно',
      WHEELCHAIR: 'За инвалидна количка',
      COMPANION: 'За придружител',
      VIP: 'VIP',
    },
    aria: 'Ред {row}, място {number}, {state}',
    /** Tooltip line 2 on a seat that carries a reservation with a name. */
    holder: 'За: {name}',
    /** Same line when the booking has no name — most of the existing ones. */
    holderUnknown: 'Без име',
    /** Appended to `seat.aria`, so it is a fragment and stays lower case. */
    ariaHolder: 'за {name}',
    /** Same rule as `ariaHolder`: a fragment the caller commas onto `seat.aria`.
     *  There is deliberately no *tooltip* counterpart — in the bubble the note's
     *  position and weight already say what it is, and a label would eat one of
     *  the three lines it has. */
    ariaNote: 'бележка: {note}',
  },
  book: {
    hint: 'Докосни свободно място, въведи име и го резервирай. Докосни своя резервация, за да я откажеш.',
    booked: 'Резервирано: ред {row}, място {seat}.',
    released: 'Освободено: ред {row}, място {seat}.',
    lost: 'Ред {row}, място {seat} току-що беше заето от друг.',
    unavailable: 'Ред {row}, място {seat} е заето.',
    /** Same as `unavailable`, but we know whose it is — the touch affordance. */
    unavailableNamed: 'Ред {row}, място {seat} е заето от {name}.',
    /** A seat an administrator switched off is not "taken", it is missing. */
    blocked: 'Ред {row}, място {seat} е недостъпно.',
    nameTitle: 'За кого е мястото?',
    nameSubmit: 'Резервирай',
    nameTooShort: 'Въведи име — поне 2 знака.',
    bookedFor: 'Резервирано за {name}: ред {row}, място {seat}.',
  },
  basket: {
    title: 'Избрани места',
    empty: 'Още не си избрал места.',
    count: '{count} места',
    countOne: '1 място',
    continue: 'Продължи',
    /** Continue label once a hold exists — the action navigates, not re-holds. */
    openHold: 'Към резервацията',
    clear: 'Изчисти',
    remove: 'Премахни',
    holding: 'Местата са задържани',
    countdown: 'Остават {time}',
    expiresSoon: 'Задържането изтича скоро!',
    expired: 'Задържането изтече. Избери местата отново.',
    maxSeats: 'Максимум {max} места на резервация.',
    seatLine: 'Сектор {subsector} · ред {row} · място {number}',
  },
  form: {
    title: 'Данни за резервацията',
    subtitle: 'Ще ти изпратим кода на резервацията.',
    name: 'Име',
    namePlaceholder: 'Име и фамилия',
    /** The click-to-book dialog's second field. Optional — the name is the
     *  required one — and the "(по избор)" sits in the label rather than beside
     *  it, so the accessible name says "optional" too. */
    note: 'Допълнителна информация',
    noteOptional: '(по избор)',
    notePlaceholder: 'напр. плаща в брой, 2 деца, вход от сектор Б',
    /** The one thing about the dialog a user cannot guess: a multi-line box in
     *  which Enter submits rather than inserting a newline. */
    noteHint: 'До {max} знака. Enter записва.',
    email: 'Имейл',
    emailPlaceholder: 'ime@example.com',
    phone: 'Телефон',
    phonePlaceholder: '+359 …',
    submit: 'Потвърди резервацията',
    submitting: 'Потвърждаване…',
    errors: {
      nameRequired: 'Въведи име.',
      emailRequired: 'Въведи имейл.',
      emailInvalid: 'Невалиден имейл адрес.',
      phoneInvalid: 'Невалиден телефонен номер.',
    },
  },
  reservation: {
    title: 'Резервация',
    code: 'Код на резервацията',
    codeHint: 'Запази този код — с него можеш да провериш или откажеш резервацията.',
    lookupTitle: 'Провери резервация',
    lookupPlaceholder: 'Код, напр. K7KQ2M',
    lookupSubmit: 'Провери',
    seatsTitle: 'Места',
    createdAt: 'Създадена',
    expiresAt: 'Изтича',
    event: 'Мач',
    confirmedTitle: 'Резервацията е потвърдена!',
    confirmedBody: 'Покажи кода на входа на стадиона.',
    cancel: 'Откажи резервацията',
    cancelConfirm: 'Наистина ли да откажем резервацията?',
    cancelled: 'Резервацията е отказана.',
    status: {
      PENDING: 'Задържана',
      CONFIRMED: 'Потвърдена',
      CANCELLED: 'Отказана',
      EXPIRED: 'Изтекла',
    },
  },
  error: {
    VALIDATION: 'Проверете въведените данни.',
    NOT_FOUND: 'Не е намерено.',
    SEATS_TAKEN: 'Част от местата вече са заети.',
    INVALID_STATE: 'Действието не е възможно в текущото състояние.',
    EXPIRED: 'Задържането изтече.',
    SALES_CLOSED: 'Продажбите за този мач са затворени.',
    RATE_LIMITED: 'Твърде много заявки. Опитай след малко.',
    INTERNAL: 'Сървърна грешка. Опитай отново.',
    NETWORK: 'Няма връзка със сървъра.',
    seatsLost: '{count} от избраните места бяха заети от друг. Премахнахме ги.',
    generic: 'Нещо се обърка.',
  },
};

const en: Dictionary = {
  brand: {
    name: 'CSKA',
    stadium: 'Bulgarian Army Stadium',
    tagline: 'Seat booking',
  },
  nav: {
    home: 'Home',
    events: 'Matches',
    overview: 'Overview',
    myReservation: 'My reservation',
    language: 'Language',
    back: 'Back',
    backToOverview: 'Back to overview',
    backToSector: 'Back to sector {code}',
  },
  common: {
    loading: 'Loading…',
    error: 'Something went wrong',
    retry: 'Try again',
    close: 'Close',
    cancel: 'Cancel',
    continue: 'Continue',
    confirm: 'Confirm',
    save: 'Save',
    next: 'Next',
    free: 'free',
    taken: 'taken',
    total: 'Total',
    from: 'from',
    seats: 'seats',
    seat: 'seat',
    row: 'row',
    yes: 'Yes',
    no: 'No',
    copy: 'Copy',
    copied: 'Copied',
    notFound: 'Not found',
    optional: 'optional',
    required: 'required',
  },
  events: {
    title: 'Upcoming matches',
    empty: 'No matches are on sale right now.',
    kickoff: 'Kick-off',
    salesOpen: 'Sales open',
    salesClose: 'Sales close',
    selectSeats: 'Pick seats',
    soldOut: 'Sold out',
    status: {
      DRAFT: 'Upcoming',
      ON_SALE: 'On sale',
      CLOSED: 'Closed',
    },
  },
  sector: {
    label: 'Sector {code}',
    'А': { name: 'South', latin: 'A' },
    'Б': { name: 'East', latin: 'B' },
    'В': { name: 'North', latin: 'V' },
    'Г': { name: 'West', latin: 'G' },
  },
  subsector: {
    label: 'Subsector {code}',
    group: '{code} · {count} blocks: {members}',
    groupHint: 'Choose a block from the list below.',
    partOf: 'part of {code}',
    seatsFree: '{free} of {total} free',
    soldOut: 'Sold out',
  },
  map: {
    overviewTitle: 'Pick a sector',
    overviewHint: 'Tap a sector to zoom in.',
    sectorHint: 'Pick a subsector.',
    seatMapHint: 'Zoom in to select seats.',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Reset view',
    pitch: 'Pitch',
    rowLabel: 'Row {row}',
    seatTooltip: 'Row {row} · Seat {number}',
    availability: {
      title: 'Availability',
      high: 'Plenty free',
      medium: 'Limited',
      low: 'Almost gone',
      none: 'Sold out',
    },
    legend: {
      title: 'Legend',
      stands: 'Stands',
    },
  },
  seat: {
    state: {
      FREE: 'Free',
      SELECTED: 'Selected',
      HELD: 'On hold',
      RESERVED: 'Reserved',
      BLOCKED: 'Unavailable',
      MINE: 'Held by you',
    },
    type: {
      STANDARD: 'Standard',
      WHEELCHAIR: 'Wheelchair space',
      COMPANION: 'Companion seat',
      VIP: 'VIP',
    },
    aria: 'Row {row}, seat {number}, {state}',
    holder: 'For: {name}',
    holderUnknown: 'No name',
    ariaHolder: 'for {name}',
    ariaNote: 'note: {note}',
  },
  book: {
    hint: 'Tap a free seat, enter a name, and book it. Tap your own booking to release it.',
    booked: 'Booked: row {row}, seat {seat}.',
    released: 'Released: row {row}, seat {seat}.',
    lost: 'Row {row}, seat {seat} was just taken by someone else.',
    unavailable: 'Row {row}, seat {seat} is taken.',
    unavailableNamed: 'Row {row}, seat {seat} is taken by {name}.',
    blocked: 'Row {row}, seat {seat} is unavailable.',
    nameTitle: 'Who is this seat for?',
    nameSubmit: 'Book seat',
    nameTooShort: 'Enter a name — at least 2 characters.',
    bookedFor: 'Booked for {name}: row {row}, seat {seat}.',
  },
  basket: {
    title: 'Selected seats',
    empty: 'No seats selected yet.',
    count: '{count} seats',
    countOne: '1 seat',
    continue: 'Continue',
    openHold: 'Go to reservation',
    clear: 'Clear',
    remove: 'Remove',
    holding: 'Seats are on hold',
    countdown: '{time} left',
    expiresSoon: 'Your hold expires soon!',
    expired: 'Your hold expired. Please pick the seats again.',
    maxSeats: 'Maximum {max} seats per reservation.',
    seatLine: 'Sector {subsector} · row {row} · seat {number}',
  },
  form: {
    title: 'Reservation details',
    subtitle: 'We will send you the reservation code.',
    name: 'Name',
    namePlaceholder: 'First and last name',
    note: 'Additional information',
    noteOptional: '(optional)',
    notePlaceholder: 'e.g. pays cash, 2 children, gate B',
    noteHint: 'Up to {max} characters. Enter saves.',
    email: 'Email',
    emailPlaceholder: 'name@example.com',
    phone: 'Phone',
    phonePlaceholder: '+359 …',
    submit: 'Confirm reservation',
    submitting: 'Confirming…',
    errors: {
      nameRequired: 'Please enter your name.',
      emailRequired: 'Please enter your email.',
      emailInvalid: 'That email address is not valid.',
      phoneInvalid: 'That phone number is not valid.',
    },
  },
  reservation: {
    title: 'Reservation',
    code: 'Reservation code',
    codeHint: 'Keep this code — use it to look up or cancel your reservation.',
    lookupTitle: 'Find a reservation',
    lookupPlaceholder: 'Code, e.g. K7KQ2M',
    lookupSubmit: 'Look up',
    seatsTitle: 'Seats',
    createdAt: 'Created',
    expiresAt: 'Expires',
    event: 'Match',
    confirmedTitle: 'Reservation confirmed!',
    confirmedBody: 'Show this code at the stadium entrance.',
    cancel: 'Cancel reservation',
    cancelConfirm: 'Really cancel this reservation?',
    cancelled: 'Reservation cancelled.',
    status: {
      PENDING: 'On hold',
      CONFIRMED: 'Confirmed',
      CANCELLED: 'Cancelled',
      EXPIRED: 'Expired',
    },
  },
  error: {
    VALIDATION: 'Please check the values you entered.',
    NOT_FOUND: 'Not found.',
    SEATS_TAKEN: 'Some of those seats have just been taken.',
    INVALID_STATE: 'That is not possible in the current state.',
    EXPIRED: 'The hold has expired.',
    SALES_CLOSED: 'Sales for this match are closed.',
    RATE_LIMITED: 'Too many requests. Please try again shortly.',
    INTERNAL: 'Server error. Please try again.',
    NETWORK: 'Cannot reach the server.',
    seatsLost: '{count} of your seats were taken by someone else and were removed.',
    generic: 'Something went wrong.',
  },
};

const dictionaries: Record<Locale, Dictionary> = { bg, en };

function lookup(dict: Dictionary, path: readonly string[]): string | undefined {
  let node: string | Dictionary | undefined = dict;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate `key` (dot path, e.g. `'seat.state.FREE'`).
 * Falls back to the other locale, then to the key itself.
 */
export function t(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const path = key.split('.');
  const primary = lookup(dictionaries[locale], path);
  if (primary !== undefined) return interpolate(primary, vars);

  const fallbackLocale: Locale = locale === 'bg' ? 'en' : 'bg';
  const fallback = lookup(dictionaries[fallbackLocale], path);
  if (fallback !== undefined) return interpolate(fallback, vars);

  return key;
}

/** Bound translator, handy in components: `const tr = translator(locale)`. */
export function translator(locale: Locale) {
  return (key: string, vars?: Record<string, string | number>): string =>
    t(locale, key, vars);
}

/** Seconds → `m:ss`, for the hold countdown. */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
