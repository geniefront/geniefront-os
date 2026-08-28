-- 0051_staff_directory_enhancements.sql: Staff Directory & Profile Enhancements

alter table staff_profiles add column if not exists employee_no text;
alter table staff_profiles add column if not exists notes text;
alter table staff_profiles add column if not exists job_title text;
