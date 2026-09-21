/**
 * Human names for HRMS columns and values.
 *
 * The schema route this service can reach returns Postgres columns, not ucode
 * field descriptors, so a column arrives with no label at all and every caller
 * fell back to the slug. That is fine for the model — it reasons in slugs — but
 * the same `FieldDef.label` is what a person reads as a table heading and in a
 * result's caption, and "second_name / birth_date / active" is a database
 * talking, not an assistant.
 *
 * A dictionary rather than a translation call: these are the columns of fifteen
 * allowlisted tables, they change about never, and a wrong-but-instant heading
 * beats a right-but-async one.
 */

const COLUMN_LABELS: Record<string, string> = {
  // People
  first_name: "Имя",
  second_name: "Фамилия",
  middle_name: "Отчество",
  full_name: "ФИО",
  employee: "Сотрудник",
  birth_date: "Дата рождения",
  gender: "Пол",
  phone: "Телефон",
  work_phone: "Рабочий телефон",
  email: "Email",
  login: "Логин",
  address: "Адрес",
  language: "Язык",
  photo: "Фото",
  avatar: "Фото",
  status: "Статус",
  // Employment
  date_hire: "Дата приёма",
  hire_date: "Дата приёма",
  date_dismissal: "Дата увольнения",
  dismissal_date: "Дата увольнения",
  salary: "Оклад",
  role_id: "Роль",
  departments_id: "Отдел",
  positions_id: "Должность",
  locations_id: "Филиал",
  regions_id: "Регион",
  employment_types_id: "Тип занятости",
  experience_levels_id: "Уровень",
  work_schedules_id: "График работы",
  dismissal_types_id: "Тип увольнения",
  dismissial_types_id: "Тип увольнения",
  dismissal_reasons_id: "Причина увольнения",
  dismissial_reasons_id: "Причина увольнения",
  user_base_id: "Сотрудник",
  // Time and attendance
  date: "Дата",
  month: "Месяц",
  check_in: "Приход",
  check_out: "Уход",
  come_time: "Приход",
  leave_time: "Уход",
  late_time: "Опоздание",
  total_late_time: "Время опозданий",
  late_days: "Опозданий, дней",
  worked_days: "Отработано дней",
  on_time_days: "Вовремя, дней",
  action_status: "Отметка",
  source_type: "Источник",
  start_date: "Начало",
  end_date: "Окончание",
  days: "Дней",
  reason: "Причина",
  comment: "Комментарий",
  absence_policies_id: "Тип отсутствия",
  // Directories and the rest
  title: "Название",
  name: "Название",
  description: "Описание",
  code: "Код",
  count: "Количество",
  total: "Количество",
};

/** Values that read as machine states in a cell. */
const VALUE_LABELS: Record<string, string> = {
  active: "Активен",
  dismissed: "Уволен",
  male: "Мужской",
  female: "Женский",
  present: "На месте",
  late: "Опоздал",
  absent: "Отсутствовал",
  accepted: "Принято",
  rejected: "Отклонено",
  requested: "На рассмотрении",
  manual: "Вручную",
  integration: "Интеграция",
  absences: "Отсутствие",
};

/** `_id_data` and `_id` name the same thing to a reader; both get the relation's label. */
const baseSlug = (slug: string): string =>
  slug.endsWith("_id_data") ? `${slug.slice(0, -8)}_id` : slug;

/**
 * What one row is called, for a person reading it.
 *
 * A person is not a `title`: their name lives in three columns, and a lookup
 * that only knows about `title`/`name` silently answers with the guid it was
 * given — which is how a chart ends up with an axis of uuids. Returns null when
 * the row has no human handle at all, so each caller picks its own fallback.
 */
export const rowLabel = (row: Record<string, unknown>): string | null => {
  const name = [row.second_name, row.first_name, row.middle_name]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  if (name) return name;
  for (const key of ["title", "name", "label"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

/**
 * A heading for a column. Unknown columns are prettified rather than left as
 * `some_column`, so a table the dictionary has never seen still reads as words.
 */
export const columnLabel = (slug: string): string => {
  const known = COLUMN_LABELS[baseSlug(slug)];
  if (known) return known;
  const words = slug.replace(/_id(_data)?$/, "").replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** `2006-02-13` → `13.02.2006`; anything else is returned untouched. */
export const formatDate = (value: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
};

/**
 * A cell as a person should read it: dates in the local order, state words in
 * Russian, everything else as it came.
 */
export const formatCell = (
  value: string | number | null,
  type?: string,
): string | number | null => {
  if (typeof value !== "string") return value;
  const t = (type ?? "").toUpperCase();
  if (t.startsWith("DATE") || /^\d{4}-\d{2}-\d{2}/.test(value)) {
    // Multi-valued columns arrive already joined by displayValue.
    return value.split(", ").map(formatDate).join(", ");
  }
  return value
    .split(", ")
    .map((part) => VALUE_LABELS[part.toLowerCase()] ?? part)
    .join(", ");
};
