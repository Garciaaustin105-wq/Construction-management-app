-- schema-baseline-2026-08-25.sql
-- Full schema-only snapshot of the live Supabase project avmqteevisqxwmmxkrbg
-- (Terra Vista construction / Terra Verde lawn -- lowvoltage-app), captured 2026-08-25.
--
-- Purpose: source of truth for rebuilding a FRESH environment. See docs/migrations-policy.md.
-- From this date forward every DDL change goes through a named apply_migration
-- (kebab-case), recorded in supabase_migrations.schema_migrations; the loose
-- root .sql files are frozen (see docs/superseded-sql-files.md).
--
-- This file is NOT a migration and is NOT idempotent. Apply it once to an EMPTY
-- database (restore into a new Supabase project or fresh local Postgres).
-- Re-running on a populated DB errors on pre-existing constraints, indexes,
-- policies and triggers. For idempotent DDL going forward, write a named
-- migration instead of editing this file.
--
-- Sections (dependency order):
--   EXTENSIONS -> SEQUENCES -> TABLES (+ ENABLE RLS) -> CONSTRAINTS -> INDEXES ->
--   FUNCTIONS (SECURITY DEFINER + helpers, CREATE OR REPLACE) -> RLS POLICIES
--   (public) -> TRIGGERS -> STORAGE BUCKETS -> STORAGE POLICIES (storage.objects).
--
-- Captured via Supabase MCP execute_sql catalog introspection:
--   pg_extension, pg_sequence, pg_attribute (incl. attidentity), pg_attrdef,
--   pg_get_constraintdef, pg_get_indexdef, pg_get_functiondef,
--   pg_get_triggerdef, pg_policies, storage.buckets.
--
-- NOTE: auth.users, the auth/storage schemas, extensions and the storage.objects
-- table itself are Supabase-managed and assumed to pre-exist; only public.*
-- tables/constraints/indexes/functions/policies/triggers and storage
-- buckets/policies are emitted here. Seed rows (notification templates, plan
-- limits, etc.) are NOT in this schema dump -- they live in their own seed files.


-- ============================================================ EXTENSIONS ============================================================
CREATE EXTENSION IF NOT EXISTS pg_stat_statements VERSION 1.11;
CREATE EXTENSION IF NOT EXISTS pgcrypto VERSION 1.3;
CREATE EXTENSION IF NOT EXISTS plpgsql VERSION 1.0;
CREATE EXTENSION IF NOT EXISTS supabase_vault VERSION 0.3.1;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" VERSION 1.1;

-- ============================================================ SEQUENCES ============================================================
CREATE SEQUENCE IF NOT EXISTS public.billing_events_id_seq AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1 NO CYCLE;

-- ============================================================== TABLES ==============================================================
CREATE TABLE IF NOT EXISTS public.accounting_connections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'active'::text,
  realm_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  access_expires_at timestamp with time zone,
  refresh_expires_at timestamp with time zone,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.accounting_connections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.ai_action_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  profile_id uuid,
  feature text NOT NULL,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_action_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.billing_events (
  id bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  organization_id uuid,
  stripe_event_id text NOT NULL,
  event_type text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  payload jsonb
);
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.blueprints (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  uploaded_by uuid,
  storage_path text NOT NULL,
  filename text NOT NULL,
  caption text,
  created_at timestamp with time zone DEFAULT now(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.blueprints ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.calendar_feeds (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  last_fetched_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.change_order_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  change_order_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  cost_code_id uuid,
  description text,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit text,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  "position" integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.change_order_lines ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.change_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  co_number text,
  title text NOT NULL,
  description text,
  reason text,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  is_credit boolean NOT NULL DEFAULT false,
  source_ref text,
  share_token uuid,
  status text NOT NULL DEFAULT 'draft'::text,
  created_by uuid,
  sent_at timestamp with time zone,
  viewed_at timestamp with time zone,
  approved_at timestamp with time zone,
  rejected_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.change_orders ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.chemical_applications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  visit_id uuid,
  product_id uuid,
  product_name text NOT NULL,
  epa_reg_number text,
  active_ingredient text,
  applicator_id uuid,
  quantity_used numeric(12,3),
  quantity_unit text,
  rate numeric(12,4),
  area_treated_sqft numeric(12,2),
  target_pest text,
  wind_mph numeric(5,1),
  temp_f numeric(5,1),
  applied_at timestamp with time zone NOT NULL DEFAULT now(),
  re_entry_hours integer,
  re_entry_until timestamp with time zone,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.chemical_applications ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.chemical_products (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  epa_reg_number text,
  active_ingredient text,
  default_rate numeric(12,4),
  rate_unit text,
  re_entry_hours integer,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.chemical_products ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.cost_codes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  category text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.cost_codes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.crew_members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  trade text,
  user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  applicator_license_number text,
  applicator_license_expires date
);
ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  created_at timestamp with time zone DEFAULT now(),
  phone text,
  address text,
  notes text,
  organization_id uuid NOT NULL,
  sms_opt_in boolean NOT NULL DEFAULT false,
  email_opt_in boolean NOT NULL DEFAULT true,
  accounting_external_id text,
  service_plan text,
  stripe_customer_id text,
  stripe_payment_method_id text,
  stripe_card_brand text,
  stripe_card_last4 text,
  stripe_card_exp_month smallint,
  stripe_card_exp_year smallint,
  autopay_enabled boolean NOT NULL DEFAULT false
);
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.daily_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  log_date date NOT NULL,
  weather text,
  work_performed text,
  equipment text,
  materials text,
  delays text,
  safety_notes text,
  crew_count integer,
  status text NOT NULL DEFAULT 'submitted'::text,
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.daily_logs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.estimate_line_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  estimate_id uuid NOT NULL,
  cost_code_id uuid,
  description text,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit text,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  "position" integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL,
  internal_cost numeric(12,2),
  section text,
  schedule_frequency text,
  schedule_interval_weeks integer NOT NULL DEFAULT 1,
  schedule_days_of_week integer[] NOT NULL DEFAULT '{}'::integer[],
  schedule_day_of_month integer,
  schedule_start_date date,
  schedule_end_date date,
  recurring_schedule_id uuid
);
ALTER TABLE public.estimate_line_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.estimate_template_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL,
  cost_code_id uuid,
  description text,
  quantity numeric(12,2) NOT NULL DEFAULT 1,
  unit text,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  internal_cost numeric(12,2),
  section text,
  "position" integer NOT NULL DEFAULT 0,
  organization_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.estimate_template_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.estimate_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.estimate_templates ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.estimates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  created_by uuid,
  title text,
  status text NOT NULL DEFAULT 'draft'::text,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  sent_at timestamp with time zone,
  approved_at timestamp with time zone,
  organization_id uuid NOT NULL,
  customer_id uuid,
  share_token uuid,
  valid_until date,
  rejected_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  customer_notes text,
  markup_pct numeric(5,2) NOT NULL DEFAULT 0,
  contingency_pct numeric(5,2) NOT NULL DEFAULT 0,
  tax_pct numeric(5,2) NOT NULL DEFAULT 0,
  deposit_pct numeric(5,2) NOT NULL DEFAULT 0,
  deposit_amount numeric(12,2) NOT NULL DEFAULT 0,
  exclusions text,
  terms text,
  payment_schedule text,
  estimate_number text,
  viewed_at timestamp with time zone,
  show_itemized boolean NOT NULL DEFAULT true,
  requires_signature boolean NOT NULL DEFAULT false,
  proposal_intro text,
  proposal_accent text,
  signed_proposal_url text,
  accounting_external_id text,
  converted_at timestamp with time zone
);
ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.install_issues (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  install_id uuid NOT NULL,
  reported_by uuid,
  description text NOT NULL,
  severity text NOT NULL DEFAULT 'normal'::text,
  status text NOT NULL DEFAULT 'open'::text,
  resolved_at timestamp with time zone,
  resolved_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.install_issues ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.install_materials (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  install_id uuid NOT NULL,
  name text NOT NULL,
  quantity numeric(12,2),
  unit text,
  serial_number text,
  added_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.install_materials ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.install_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  install_id uuid NOT NULL,
  author_id uuid,
  body text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.install_notes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.install_time_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  install_id uuid NOT NULL,
  user_id uuid NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.install_time_entries ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.install_types (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.install_types ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.installs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid,
  customer_id uuid,
  install_type_id uuid,
  title text NOT NULL,
  price numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'scheduled'::text,
  address text,
  scheduled_at timestamp with time zone,
  duration_minutes integer,
  assigned_crew uuid[] NOT NULL DEFAULT '{}'::uuid[],
  notes text,
  completed_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  has_open_problem boolean NOT NULL DEFAULT false,
  completion_outcome text,
  priority text DEFAULT 'normal'::text,
  po_number text,
  site_contact_name text,
  site_contact_phone text
);
ALTER TABLE public.installs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_id uuid,
  description text,
  quantity numeric(10,2) DEFAULT 1,
  unit_price numeric(10,2) DEFAULT 0,
  "position" integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.invoices (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  customer_id uuid,
  status text DEFAULT 'sent'::text,
  paid_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  organization_id uuid NOT NULL,
  due_date date,
  estimate_id uuid,
  amount_paid numeric(12,2) NOT NULL DEFAULT 0,
  share_token uuid,
  sent_at timestamp with time zone,
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  accounting_external_id text
);
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.job_inspections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  title text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'required'::text,
  scheduled_date date,
  inspector text,
  notes text,
  cost_code_id uuid,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.job_inspections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.job_subcontractors (
  job_id uuid NOT NULL,
  subcontractor_id uuid NOT NULL,
  role_on_job text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL,
  scheduled_date date
);
ALTER TABLE public.job_subcontractors ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.job_tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'task'::text,
  cost_code_id uuid,
  start_date date NOT NULL,
  end_date date,
  "position" integer NOT NULL DEFAULT 0,
  percent_complete integer NOT NULL DEFAULT 0,
  predecessor_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  dependency_type text DEFAULT 'FS'::text,
  assigned_to uuid,
  baseline_start date,
  baseline_end date,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.job_tasks ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.job_views (
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.job_views ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  name text NOT NULL,
  address text,
  description text,
  status text NOT NULL DEFAULT 'scheduled'::text,
  scheduled_start date,
  scheduled_end date,
  assigned_crew uuid[] DEFAULT '{}'::uuid[],
  created_at timestamp with time zone DEFAULT now(),
  labor_rate numeric(10,2),
  organization_id uuid NOT NULL,
  type text NOT NULL DEFAULT 'construction'::text,
  project_type text
);
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.lawn_jobs (
  id uuid NOT NULL,
  organization_id uuid NOT NULL,
  lot_sqft numeric,
  gate_code text,
  pets text,
  access_notes text,
  obstacles text,
  sprinkler boolean NOT NULL DEFAULT false,
  map_lat numeric,
  map_lng numeric,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.lawn_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.lawn_services (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  default_price numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  default_duration_minutes integer
);
ALTER TABLE public.lawn_services ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.lawn_visits (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  recurring_schedule_id uuid NOT NULL,
  job_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  crew_id uuid,
  completed_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  notified_at timestamp with time zone,
  invoice_id uuid,
  route_order integer,
  share_token uuid DEFAULT gen_random_uuid(),
  notified_skipped_at timestamp with time zone,
  skip_reason text,
  started_at timestamp with time zone,
  scheduled_window_start time without time zone,
  scheduled_window_end time without time zone
);
ALTER TABLE public.lawn_visits ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  address text,
  service_interest text,
  source text NOT NULL DEFAULT 'website'::text,
  referral_detail text,
  referred_by_customer_id uuid,
  status text NOT NULL DEFAULT 'new'::text,
  assigned_to uuid,
  notes text,
  converted_customer_id uuid,
  converted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid
);
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.notification_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  event text NOT NULL,
  channel text NOT NULL,
  to_contact text,
  entity_type text NOT NULL,
  entity_id uuid,
  status text NOT NULL,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.notification_settings (
  organization_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  google_review_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.notification_templates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  event text NOT NULL,
  channel text NOT NULL,
  subject text,
  body text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  href text,
  entity_id uuid,
  read_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid,
  address text,
  phone text,
  email text,
  logo_path text,
  plan text NOT NULL DEFAULT 'trial'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  stripe_customer_id text,
  stripe_subscription_id text,
  trial_ends_at timestamp with time zone,
  plan_status text NOT NULL DEFAULT 'trial'::text,
  subscription_amount_cents integer NOT NULL DEFAULT 0,
  stripe_connect_account_id text,
  connect_charges_enabled boolean NOT NULL DEFAULT false,
  connect_details_submitted boolean NOT NULL DEFAULT false,
  app_variant text NOT NULL DEFAULT 'construction'::text,
  storage_bytes bigint NOT NULL DEFAULT 0,
  isp_module_enabled boolean NOT NULL DEFAULT false,
  lead_form_token text,
  connect_losses_owner text
);
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.password_resets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  method text NOT NULL,
  reference text,
  paid_at timestamp with time zone NOT NULL DEFAULT now(),
  recorded_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.photos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  uploaded_by uuid,
  storage_path text NOT NULL,
  caption text,
  created_at timestamp with time zone DEFAULT now(),
  lat double precision,
  lng double precision,
  location_source text,
  location_accuracy numeric(8,2),
  organization_id uuid NOT NULL,
  visit_id uuid,
  daily_log_id uuid,
  punch_item_id uuid,
  install_id uuid
);
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.portal_approvals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid,
  document_type text NOT NULL,
  document_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  signer_name text NOT NULL,
  signature_text text NOT NULL,
  signature_image_path text,
  signed_pdf_path text,
  signer_ip inet,
  action text NOT NULL DEFAULT 'approved'::text,
  signed_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.portal_approvals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.portal_messages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  sender text NOT NULL,
  body text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  read_at timestamp with time zone
);
ALTER TABLE public.portal_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL,
  email text NOT NULL,
  full_name text,
  role text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  customer_id uuid,
  organization_id uuid
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.punch_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  location text,
  assigned_to uuid,
  status text NOT NULL DEFAULT 'open'::text,
  priority text NOT NULL DEFAULT 'normal'::text,
  due_date date,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  completed_by uuid
);
ALTER TABLE public.punch_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  uploaded_by uuid NOT NULL,
  storage_path text NOT NULL,
  vendor text,
  amount numeric(10,2),
  notes text,
  captured_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  uploaded_by_name text,
  reimbursed boolean NOT NULL DEFAULT false,
  reimbursed_at timestamp with time zone,
  category text,
  tax numeric(10,2),
  payment_method text,
  receipt_no text,
  cost_code_id uuid,
  organization_id uuid NOT NULL,
  lat double precision,
  lng double precision,
  location_source text,
  location_accuracy numeric(8,2)
);
ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.recurring_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  frequency text NOT NULL,
  interval_weeks integer NOT NULL DEFAULT 1,
  days_of_week integer[] NOT NULL DEFAULT '{}'::integer[],
  day_of_month integer,
  start_date date NOT NULL,
  end_date date,
  service_type text,
  price_per_visit numeric(12,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  paused_from date,
  paused_until date,
  estimated_duration_minutes integer
);
ALTER TABLE public.recurring_schedules ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.review_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  customer_id uuid,
  visit_id uuid,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  channel text NOT NULL DEFAULT 'email'::text,
  rating smallint,
  feedback text,
  status text NOT NULL DEFAULT 'sent'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  opened_at timestamp with time zone,
  completed_at timestamp with time zone
);
ALTER TABLE public.review_requests ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.rfis (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid,
  submitted_by uuid,
  question text NOT NULL,
  answer text,
  status text NOT NULL DEFAULT 'open'::text,
  created_at timestamp with time zone DEFAULT now(),
  answered_at timestamp with time zone,
  organization_id uuid NOT NULL
);
ALTER TABLE public.rfis ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.route_optimizations_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  profile_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.route_optimizations_log ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.schedule_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  title text NOT NULL,
  start_at timestamp with time zone NOT NULL,
  end_at timestamp with time zone,
  kind text NOT NULL,
  notes text,
  created_by uuid,
  organization_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.schedule_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.subcontractor_attachments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subcontractor_id uuid NOT NULL,
  filename text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.subcontractor_attachments ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.subcontractors (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company text NOT NULL,
  contact_name text,
  trade text,
  phone text,
  email text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  organization_id uuid NOT NULL
);
ALTER TABLE public.subcontractors ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.submittal_files (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  submittal_id uuid NOT NULL,
  filename text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.submittal_files ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.submittals (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  job_id uuid NOT NULL,
  submittal_number text,
  title text NOT NULL,
  description text,
  csi_section text,
  cost_code_id uuid,
  status text NOT NULL DEFAULT 'draft'::text,
  disposition text,
  ball_in_court text NOT NULL DEFAULT 'office'::text,
  share_token uuid,
  created_by uuid,
  sent_at timestamp with time zone,
  viewed_at timestamp with time zone,
  returned_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.submittals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.time_entries (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  cost_code_id uuid,
  clock_in_at timestamp with time zone NOT NULL DEFAULT now(),
  clock_out_at timestamp with time zone,
  lat double precision,
  lng double precision,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  location_source text,
  location_accuracy numeric(8,2),
  organization_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  approved_by uuid,
  approved_at timestamp with time zone
);
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

-- =========================================================== CONSTRAINTS ===========================================================
ALTER TABLE public.accounting_connections ADD CONSTRAINT accounting_connections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.accounting_connections ADD CONSTRAINT accounting_connections_pkey PRIMARY KEY (id);
ALTER TABLE public.accounting_connections ADD CONSTRAINT accounting_connections_organization_id_provider_key UNIQUE (organization_id, provider);
ALTER TABLE public.ai_action_log ADD CONSTRAINT ai_action_log_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.ai_action_log ADD CONSTRAINT ai_action_log_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.ai_action_log ADD CONSTRAINT ai_action_log_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_events ADD CONSTRAINT billing_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.billing_events ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);
ALTER TABLE public.billing_events ADD CONSTRAINT billing_events_stripe_event_id_key UNIQUE (stripe_event_id);
ALTER TABLE public.blueprints ADD CONSTRAINT blueprints_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.blueprints ADD CONSTRAINT blueprints_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.blueprints ADD CONSTRAINT blueprints_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
ALTER TABLE public.blueprints ADD CONSTRAINT blueprints_pkey PRIMARY KEY (id);
ALTER TABLE public.calendar_feeds ADD CONSTRAINT calendar_feeds_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.calendar_feeds ADD CONSTRAINT calendar_feeds_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.calendar_feeds ADD CONSTRAINT calendar_feeds_pkey PRIMARY KEY (id);
ALTER TABLE public.change_order_lines ADD CONSTRAINT change_order_lines_change_order_id_fkey FOREIGN KEY (change_order_id) REFERENCES change_orders(id) ON DELETE CASCADE;
ALTER TABLE public.change_order_lines ADD CONSTRAINT change_order_lines_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.change_order_lines ADD CONSTRAINT change_order_lines_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.change_order_lines ADD CONSTRAINT change_order_lines_pkey PRIMARY KEY (id);
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'sent'::text, 'approved'::text, 'rejected'::text, 'void'::text])));
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.change_orders ADD CONSTRAINT change_orders_pkey PRIMARY KEY (id);
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_applicator_id_fkey FOREIGN KEY (applicator_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_product_id_fkey FOREIGN KEY (product_id) REFERENCES chemical_products(id) ON DELETE SET NULL;
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES lawn_visits(id) ON DELETE SET NULL;
ALTER TABLE public.chemical_applications ADD CONSTRAINT chemical_applications_pkey PRIMARY KEY (id);
ALTER TABLE public.chemical_products ADD CONSTRAINT chemical_products_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.chemical_products ADD CONSTRAINT chemical_products_pkey PRIMARY KEY (id);
ALTER TABLE public.cost_codes ADD CONSTRAINT cost_codes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.cost_codes ADD CONSTRAINT cost_codes_pkey PRIMARY KEY (id);
ALTER TABLE public.cost_codes ADD CONSTRAINT cost_codes_code_key UNIQUE (code);
ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_pkey PRIMARY KEY (id);
ALTER TABLE public.crew_members ADD CONSTRAINT crew_members_organization_id_user_id_key UNIQUE (organization_id, user_id);
ALTER TABLE public.customers ADD CONSTRAINT customers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE public.daily_logs ADD CONSTRAINT daily_logs_status_check CHECK ((status = ANY (ARRAY['submitted'::text, 'reviewed'::text])));
ALTER TABLE public.daily_logs ADD CONSTRAINT daily_logs_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.daily_logs ADD CONSTRAINT daily_logs_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.daily_logs ADD CONSTRAINT daily_logs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.daily_logs ADD CONSTRAINT daily_logs_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.daily_logs ADD CONSTRAINT daily_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.estimate_line_items ADD CONSTRAINT estimate_line_items_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.estimate_line_items ADD CONSTRAINT estimate_line_items_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE;
ALTER TABLE public.estimate_line_items ADD CONSTRAINT estimate_line_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.estimate_line_items ADD CONSTRAINT estimate_line_items_recurring_schedule_id_fkey FOREIGN KEY (recurring_schedule_id) REFERENCES recurring_schedules(id) ON DELETE SET NULL;
ALTER TABLE public.estimate_line_items ADD CONSTRAINT estimate_line_items_pkey PRIMARY KEY (id);
ALTER TABLE public.estimate_template_items ADD CONSTRAINT estimate_template_items_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.estimate_template_items ADD CONSTRAINT estimate_template_items_template_id_fkey FOREIGN KEY (template_id) REFERENCES estimate_templates(id) ON DELETE CASCADE;
ALTER TABLE public.estimate_template_items ADD CONSTRAINT estimate_template_items_pkey PRIMARY KEY (id);
ALTER TABLE public.estimate_templates ADD CONSTRAINT estimate_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE public.estimate_templates ADD CONSTRAINT estimate_templates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.estimate_templates ADD CONSTRAINT estimate_templates_pkey PRIMARY KEY (id);
ALTER TABLE public.estimates ADD CONSTRAINT estimates_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'approved'::text, 'converted'::text, 'rejected'::text])));
ALTER TABLE public.estimates ADD CONSTRAINT estimates_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
ALTER TABLE public.estimates ADD CONSTRAINT estimates_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.estimates ADD CONSTRAINT estimates_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.estimates ADD CONSTRAINT estimates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.estimates ADD CONSTRAINT estimates_pkey PRIMARY KEY (id);
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_description_check CHECK ((length(btrim(description)) > 0));
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text])));
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])));
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_install_id_fkey FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE;
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.install_issues ADD CONSTRAINT install_issues_pkey PRIMARY KEY (id);
ALTER TABLE public.install_materials ADD CONSTRAINT install_materials_name_check CHECK ((length(btrim(name)) > 0));
ALTER TABLE public.install_materials ADD CONSTRAINT install_materials_quantity_check CHECK (((quantity IS NULL) OR (quantity >= (0)::numeric)));
ALTER TABLE public.install_materials ADD CONSTRAINT install_materials_added_by_fkey FOREIGN KEY (added_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.install_materials ADD CONSTRAINT install_materials_install_id_fkey FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE;
ALTER TABLE public.install_materials ADD CONSTRAINT install_materials_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.install_materials ADD CONSTRAINT install_materials_pkey PRIMARY KEY (id);
ALTER TABLE public.install_notes ADD CONSTRAINT install_notes_body_check CHECK ((length(btrim(body)) > 0));
ALTER TABLE public.install_notes ADD CONSTRAINT install_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.install_notes ADD CONSTRAINT install_notes_install_id_fkey FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE;
ALTER TABLE public.install_notes ADD CONSTRAINT install_notes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.install_notes ADD CONSTRAINT install_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.install_time_entries ADD CONSTRAINT install_time_entries_range_ck CHECK (((ended_at IS NULL) OR (ended_at >= started_at)));
ALTER TABLE public.install_time_entries ADD CONSTRAINT install_time_entries_install_id_fkey FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE;
ALTER TABLE public.install_time_entries ADD CONSTRAINT install_time_entries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.install_time_entries ADD CONSTRAINT install_time_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.install_time_entries ADD CONSTRAINT install_time_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.install_types ADD CONSTRAINT install_types_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.install_types ADD CONSTRAINT install_types_pkey PRIMARY KEY (id);
ALTER TABLE public.installs ADD CONSTRAINT installs_completion_outcome_check CHECK (((completion_outcome IS NULL) OR (completion_outcome = ANY (ARRAY['completed'::text, 'partial'::text, 'could_not_complete'::text]))));
ALTER TABLE public.installs ADD CONSTRAINT installs_duration_minutes_check CHECK (((duration_minutes IS NULL) OR (duration_minutes > 0)));
ALTER TABLE public.installs ADD CONSTRAINT installs_price_check CHECK ((price >= (0)::numeric));
ALTER TABLE public.installs ADD CONSTRAINT installs_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'completed'::text, 'needs_followup'::text, 'cancelled'::text])));
ALTER TABLE public.installs ADD CONSTRAINT installs_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.installs ADD CONSTRAINT installs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.installs ADD CONSTRAINT installs_install_type_id_fkey FOREIGN KEY (install_type_id) REFERENCES install_types(id) ON DELETE RESTRICT;
ALTER TABLE public.installs ADD CONSTRAINT installs_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE public.installs ADD CONSTRAINT installs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.installs ADD CONSTRAINT installs_pkey PRIMARY KEY (id);
ALTER TABLE public.invoice_line_items ADD CONSTRAINT invoice_line_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_line_items ADD CONSTRAINT invoice_line_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_line_items ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);
ALTER TABLE public.invoices ADD CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'paid'::text, 'void'::text])));
ALTER TABLE public.invoices ADD CONSTRAINT invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_estimate_id_fkey FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.job_inspections ADD CONSTRAINT job_inspections_pkey PRIMARY KEY (id);
ALTER TABLE public.job_subcontractors ADD CONSTRAINT job_subcontractors_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.job_subcontractors ADD CONSTRAINT job_subcontractors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.job_subcontractors ADD CONSTRAINT job_subcontractors_subcontractor_id_fkey FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id) ON DELETE CASCADE;
ALTER TABLE public.job_subcontractors ADD CONSTRAINT job_subcontractors_pkey PRIMARY KEY (job_id, subcontractor_id);
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_check CHECK (((kind = 'milestone'::text) OR (end_date IS NOT NULL)));
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_check1 CHECK (((kind <> 'milestone'::text) OR (end_date IS NULL)));
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_check2 CHECK (((kind = 'milestone'::text) OR (end_date >= start_date)));
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_percent_complete_check CHECK (((percent_complete >= 0) AND (percent_complete <= 100)));
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.job_tasks ADD CONSTRAINT job_tasks_pkey PRIMARY KEY (id);
ALTER TABLE public.job_views ADD CONSTRAINT job_views_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.job_views ADD CONSTRAINT job_views_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.job_views ADD CONSTRAINT job_views_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.job_views ADD CONSTRAINT job_views_pkey PRIMARY KEY (user_id, job_id);
ALTER TABLE public.jobs ADD CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'on_hold'::text, 'completed'::text])));
ALTER TABLE public.jobs ADD CONSTRAINT jobs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.lawn_jobs ADD CONSTRAINT lawn_jobs_id_fkey FOREIGN KEY (id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.lawn_jobs ADD CONSTRAINT lawn_jobs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.lawn_jobs ADD CONSTRAINT lawn_jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.lawn_services ADD CONSTRAINT lawn_services_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.lawn_services ADD CONSTRAINT lawn_services_pkey PRIMARY KEY (id);
ALTER TABLE public.lawn_visits ADD CONSTRAINT lawn_visits_crew_id_fkey FOREIGN KEY (crew_id) REFERENCES crew_members(id) ON DELETE SET NULL;
ALTER TABLE public.lawn_visits ADD CONSTRAINT lawn_visits_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
ALTER TABLE public.lawn_visits ADD CONSTRAINT lawn_visits_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.lawn_visits ADD CONSTRAINT lawn_visits_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.lawn_visits ADD CONSTRAINT lawn_visits_recurring_schedule_id_fkey FOREIGN KEY (recurring_schedule_id) REFERENCES recurring_schedules(id) ON DELETE CASCADE;
ALTER TABLE public.lawn_visits ADD CONSTRAINT lawn_visits_pkey PRIMARY KEY (id);
ALTER TABLE public.leads ADD CONSTRAINT leads_source_check CHECK ((source = ANY (ARRAY['website'::text, 'referral'::text, 'google'::text, 'other'::text, 'manual'::text])));
ALTER TABLE public.leads ADD CONSTRAINT leads_status_check CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'quoted'::text, 'won'::text, 'lost'::text])));
ALTER TABLE public.leads ADD CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.leads ADD CONSTRAINT leads_converted_customer_id_fkey FOREIGN KEY (converted_customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.leads ADD CONSTRAINT leads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.leads ADD CONSTRAINT leads_referred_by_customer_id_fkey FOREIGN KEY (referred_by_customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.leads ADD CONSTRAINT leads_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_log ADD CONSTRAINT notification_log_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.notification_log ADD CONSTRAINT notification_log_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_settings ADD CONSTRAINT notification_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.notification_settings ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (organization_id);
ALTER TABLE public.notification_templates ADD CONSTRAINT notification_templates_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.notification_templates ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);
ALTER TABLE public.notification_templates ADD CONSTRAINT notification_templates_organization_id_event_channel_key UNIQUE (organization_id, event, channel);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.organizations ADD CONSTRAINT organizations_app_variant_check CHECK ((app_variant = ANY (ARRAY['construction'::text, 'lawn'::text])));
ALTER TABLE public.organizations ADD CONSTRAINT organizations_plan_check CHECK ((plan = ANY (ARRAY['trial'::text, 'starter'::text, 'pro'::text, 'enterprise'::text, 'expired'::text, 'canceled'::text, 'free'::text])));
ALTER TABLE public.organizations ADD CONSTRAINT organizations_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
ALTER TABLE public.organizations ADD CONSTRAINT organizations_lead_form_token_key UNIQUE (lead_form_token);
ALTER TABLE public.password_resets ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.password_resets ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);
ALTER TABLE public.payments ADD CONSTRAINT payments_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.payments ADD CONSTRAINT payments_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'check'::text, 'other'::text])));
ALTER TABLE public.payments ADD CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE public.payments ADD CONSTRAINT payments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.payments ADD CONSTRAINT payments_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE public.photos ADD CONSTRAINT photos_daily_log_id_fkey FOREIGN KEY (daily_log_id) REFERENCES daily_logs(id) ON DELETE SET NULL;
ALTER TABLE public.photos ADD CONSTRAINT photos_install_id_fkey FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE;
ALTER TABLE public.photos ADD CONSTRAINT photos_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.photos ADD CONSTRAINT photos_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.photos ADD CONSTRAINT photos_punch_item_id_fkey FOREIGN KEY (punch_item_id) REFERENCES punch_items(id) ON DELETE SET NULL;
ALTER TABLE public.photos ADD CONSTRAINT photos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
ALTER TABLE public.photos ADD CONSTRAINT photos_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES lawn_visits(id) ON DELETE SET NULL;
ALTER TABLE public.photos ADD CONSTRAINT photos_pkey PRIMARY KEY (id);
ALTER TABLE public.portal_approvals ADD CONSTRAINT portal_approvals_action_check CHECK ((action = ANY (ARRAY['approved'::text, 'declined'::text])));
ALTER TABLE public.portal_approvals ADD CONSTRAINT portal_approvals_document_type_check CHECK ((document_type = 'estimate'::text));
ALTER TABLE public.portal_approvals ADD CONSTRAINT portal_approvals_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.portal_approvals ADD CONSTRAINT portal_approvals_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE public.portal_approvals ADD CONSTRAINT portal_approvals_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.portal_approvals ADD CONSTRAINT portal_approvals_pkey PRIMARY KEY (id);
ALTER TABLE public.portal_messages ADD CONSTRAINT portal_messages_sender_check CHECK ((sender = ANY (ARRAY['client'::text, 'office'::text])));
ALTER TABLE public.portal_messages ADD CONSTRAINT portal_messages_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.portal_messages ADD CONSTRAINT portal_messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.portal_messages ADD CONSTRAINT portal_messages_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_org_check CHECK ((((role = 'super_admin'::text) AND (organization_id IS NULL)) OR ((role <> 'super_admin'::text) AND (organization_id IS NOT NULL))));
ALTER TABLE public.profiles ADD CONSTRAINT profiles_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text])));
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'complete'::text, 'void'::text])));
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.punch_items ADD CONSTRAINT punch_items_pkey PRIMARY KEY (id);
ALTER TABLE public.receipts ADD CONSTRAINT receipts_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.receipts ADD CONSTRAINT receipts_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.receipts ADD CONSTRAINT receipts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.receipts ADD CONSTRAINT receipts_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);
ALTER TABLE public.receipts ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);
ALTER TABLE public.recurring_schedules ADD CONSTRAINT recurring_schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.recurring_schedules ADD CONSTRAINT recurring_schedules_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.recurring_schedules ADD CONSTRAINT recurring_schedules_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.recurring_schedules ADD CONSTRAINT recurring_schedules_pkey PRIMARY KEY (id);
ALTER TABLE public.review_requests ADD CONSTRAINT review_rating_check CHECK (((rating IS NULL) OR ((rating >= 1) AND (rating <= 5))));
ALTER TABLE public.review_requests ADD CONSTRAINT review_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE public.review_requests ADD CONSTRAINT review_requests_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.review_requests ADD CONSTRAINT review_requests_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES lawn_visits(id) ON DELETE SET NULL;
ALTER TABLE public.review_requests ADD CONSTRAINT review_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.review_requests ADD CONSTRAINT review_requests_token_key UNIQUE (token);
ALTER TABLE public.rfis ADD CONSTRAINT rfis_status_check CHECK ((status = ANY (ARRAY['open'::text, 'answered'::text, 'closed'::text])));
ALTER TABLE public.rfis ADD CONSTRAINT rfis_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.rfis ADD CONSTRAINT rfis_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.rfis ADD CONSTRAINT rfis_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES profiles(id);
ALTER TABLE public.rfis ADD CONSTRAINT rfis_pkey PRIMARY KEY (id);
ALTER TABLE public.route_optimizations_log ADD CONSTRAINT route_optimizations_log_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.route_optimizations_log ADD CONSTRAINT route_optimizations_log_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.route_optimizations_log ADD CONSTRAINT route_optimizations_log_pkey PRIMARY KEY (id);
ALTER TABLE public.schedule_events ADD CONSTRAINT schedule_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.schedule_events ADD CONSTRAINT schedule_events_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.schedule_events ADD CONSTRAINT schedule_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.schedule_events ADD CONSTRAINT schedule_events_pkey PRIMARY KEY (id);
ALTER TABLE public.subcontractor_attachments ADD CONSTRAINT subcontractor_attachments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.subcontractor_attachments ADD CONSTRAINT subcontractor_attachments_subcontractor_id_fkey FOREIGN KEY (subcontractor_id) REFERENCES subcontractors(id) ON DELETE CASCADE;
ALTER TABLE public.subcontractor_attachments ADD CONSTRAINT subcontractor_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.subcontractor_attachments ADD CONSTRAINT subcontractor_attachments_pkey PRIMARY KEY (id);
ALTER TABLE public.subcontractors ADD CONSTRAINT subcontractors_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.subcontractors ADD CONSTRAINT subcontractors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.subcontractors ADD CONSTRAINT subcontractors_pkey PRIMARY KEY (id);
ALTER TABLE public.submittal_files ADD CONSTRAINT submittal_files_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.submittal_files ADD CONSTRAINT submittal_files_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.submittal_files ADD CONSTRAINT submittal_files_submittal_id_fkey FOREIGN KEY (submittal_id) REFERENCES submittals(id) ON DELETE CASCADE;
ALTER TABLE public.submittal_files ADD CONSTRAINT submittal_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.submittal_files ADD CONSTRAINT submittal_files_pkey PRIMARY KEY (id);
ALTER TABLE public.submittals ADD CONSTRAINT submittals_ball_in_court_check CHECK ((ball_in_court = ANY (ARRAY['office'::text, 'architect'::text])));
ALTER TABLE public.submittals ADD CONSTRAINT submittals_disposition_check CHECK ((disposition = ANY (ARRAY['approved'::text, 'approved_as_noted'::text, 'revise_resubmit'::text, 'rejected'::text])));
ALTER TABLE public.submittals ADD CONSTRAINT submittals_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'returned'::text, 'closed'::text])));
ALTER TABLE public.submittals ADD CONSTRAINT submittals_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.submittals ADD CONSTRAINT submittals_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.submittals ADD CONSTRAINT submittals_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.submittals ADD CONSTRAINT submittals_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.submittals ADD CONSTRAINT submittals_pkey PRIMARY KEY (id);
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_cost_code_id_fkey FOREIGN KEY (cost_code_id) REFERENCES cost_codes(id) ON DELETE SET NULL;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.time_entries ADD CONSTRAINT time_entries_pkey PRIMARY KEY (id);

-- ============================================================= INDEXES =============================================================
CREATE UNIQUE INDEX accounting_connections_pkey ON public.accounting_connections USING btree (id)
CREATE UNIQUE INDEX accounting_connections_organization_id_provider_key ON public.accounting_connections USING btree (organization_id, provider)
CREATE INDEX idx_accounting_connections_org ON public.accounting_connections USING btree (organization_id)
CREATE UNIQUE INDEX ai_action_log_pkey ON public.ai_action_log USING btree (id)
CREATE INDEX idx_ai_action_log_org_month ON public.ai_action_log USING btree (organization_id, created_at)
CREATE UNIQUE INDEX billing_events_pkey ON public.billing_events USING btree (id)
CREATE UNIQUE INDEX billing_events_stripe_event_id_key ON public.billing_events USING btree (stripe_event_id)
CREATE UNIQUE INDEX blueprints_pkey ON public.blueprints USING btree (id)
CREATE UNIQUE INDEX calendar_feeds_pkey ON public.calendar_feeds USING btree (id)
CREATE UNIQUE INDEX idx_calendar_feeds_user ON public.calendar_feeds USING btree (user_id)
CREATE UNIQUE INDEX idx_calendar_feeds_token ON public.calendar_feeds USING btree (token)
CREATE UNIQUE INDEX change_order_lines_pkey ON public.change_order_lines USING btree (id)
CREATE INDEX idx_change_order_lines_co ON public.change_order_lines USING btree (change_order_id)
CREATE UNIQUE INDEX change_orders_pkey ON public.change_orders USING btree (id)
CREATE INDEX idx_change_orders_job ON public.change_orders USING btree (job_id)
CREATE INDEX idx_change_orders_org_status ON public.change_orders USING btree (organization_id, status)
CREATE UNIQUE INDEX idx_change_orders_co_number_org ON public.change_orders USING btree (co_number, organization_id) WHERE (co_number IS NOT NULL)
CREATE UNIQUE INDEX idx_change_orders_share_token ON public.change_orders USING btree (share_token) WHERE (share_token IS NOT NULL)
CREATE UNIQUE INDEX chemical_applications_pkey ON public.chemical_applications USING btree (id)
CREATE INDEX idx_chem_app_org_date ON public.chemical_applications USING btree (organization_id, applied_at DESC)
CREATE INDEX idx_chem_app_job ON public.chemical_applications USING btree (job_id)
CREATE INDEX idx_chem_app_visit ON public.chemical_applications USING btree (visit_id)
CREATE INDEX idx_chem_app_applicator ON public.chemical_applications USING btree (applicator_id)
CREATE UNIQUE INDEX chemical_products_pkey ON public.chemical_products USING btree (id)
CREATE INDEX idx_chemical_products_org ON public.chemical_products USING btree (organization_id, name)
CREATE UNIQUE INDEX cost_codes_pkey ON public.cost_codes USING btree (id)
CREATE UNIQUE INDEX cost_codes_code_key ON public.cost_codes USING btree (code)
CREATE UNIQUE INDEX crew_members_pkey ON public.crew_members USING btree (id)
CREATE UNIQUE INDEX crew_members_organization_id_user_id_key ON public.crew_members USING btree (organization_id, user_id)
CREATE INDEX idx_crew_members_org ON public.crew_members USING btree (organization_id)
CREATE INDEX idx_crew_members_user ON public.crew_members USING btree (user_id) WHERE (user_id IS NOT NULL)
CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)
CREATE INDEX idx_customers_accounting_ext ON public.customers USING btree (accounting_external_id) WHERE (accounting_external_id IS NOT NULL)
CREATE INDEX idx_customers_org_name ON public.customers USING btree (organization_id, name)
CREATE UNIQUE INDEX daily_logs_pkey ON public.daily_logs USING btree (id)
CREATE INDEX idx_daily_logs_job ON public.daily_logs USING btree (job_id)
CREATE INDEX idx_daily_logs_org_date ON public.daily_logs USING btree (organization_id, log_date DESC)
CREATE UNIQUE INDEX idx_daily_logs_job_date ON public.daily_logs USING btree (job_id, log_date)
CREATE UNIQUE INDEX estimate_line_items_pkey ON public.estimate_line_items USING btree (id)
CREATE INDEX estimate_line_items_estimate_id_idx ON public.estimate_line_items USING btree (estimate_id)
CREATE UNIQUE INDEX estimate_template_items_pkey ON public.estimate_template_items USING btree (id)
CREATE UNIQUE INDEX estimate_templates_pkey ON public.estimate_templates USING btree (id)
CREATE UNIQUE INDEX estimates_pkey ON public.estimates USING btree (id)
CREATE INDEX estimates_job_id_idx ON public.estimates USING btree (job_id)
CREATE INDEX estimates_status_idx ON public.estimates USING btree (status)
CREATE UNIQUE INDEX estimates_share_token_key ON public.estimates USING btree (share_token)
CREATE UNIQUE INDEX estimates_estimate_number_unique_org ON public.estimates USING btree (organization_id, estimate_number) WHERE (estimate_number IS NOT NULL)
CREATE INDEX idx_estimates_org_created ON public.estimates USING btree (organization_id, created_at DESC)
CREATE INDEX idx_estimates_org_approved ON public.estimates USING btree (organization_id, created_at DESC) WHERE (status = 'approved'::text)
CREATE UNIQUE INDEX install_issues_pkey ON public.install_issues USING btree (id)
CREATE INDEX install_issues_install_idx ON public.install_issues USING btree (install_id, created_at)
CREATE INDEX install_issues_open_idx ON public.install_issues USING btree (organization_id, status) WHERE (status = 'open'::text)
CREATE UNIQUE INDEX install_materials_pkey ON public.install_materials USING btree (id)
CREATE INDEX install_materials_install_idx ON public.install_materials USING btree (install_id, created_at)
CREATE INDEX install_materials_serial_idx ON public.install_materials USING btree (organization_id, serial_number) WHERE (serial_number IS NOT NULL)
CREATE UNIQUE INDEX install_notes_pkey ON public.install_notes USING btree (id)
CREATE INDEX install_notes_install_idx ON public.install_notes USING btree (install_id, created_at)
CREATE UNIQUE INDEX install_time_entries_pkey ON public.install_time_entries USING btree (id)
CREATE INDEX install_time_entries_install_idx ON public.install_time_entries USING btree (install_id, started_at)
CREATE INDEX install_time_entries_user_idx ON public.install_time_entries USING btree (user_id, started_at)
CREATE UNIQUE INDEX install_time_entries_one_open_idx ON public.install_time_entries USING btree (install_id, user_id) WHERE (ended_at IS NULL)
CREATE UNIQUE INDEX install_types_pkey ON public.install_types USING btree (id)
CREATE UNIQUE INDEX install_types_org_name_key ON public.install_types USING btree (organization_id, lower(name))
CREATE UNIQUE INDEX installs_pkey ON public.installs USING btree (id)
CREATE INDEX installs_org_scheduled_idx ON public.installs USING btree (organization_id, scheduled_at)
CREATE INDEX installs_job_id_idx ON public.installs USING btree (job_id)
CREATE INDEX installs_customer_id_idx ON public.installs USING btree (customer_id)
CREATE INDEX installs_status_idx ON public.installs USING btree (organization_id, status)
CREATE UNIQUE INDEX invoice_line_items_pkey ON public.invoice_line_items USING btree (id)
CREATE INDEX invoice_line_items_invoice_id_idx ON public.invoice_line_items USING btree (invoice_id)
CREATE UNIQUE INDEX invoices_pkey ON public.invoices USING btree (id)
CREATE INDEX invoices_job_id_idx ON public.invoices USING btree (job_id)
CREATE INDEX invoices_customer_id_idx ON public.invoices USING btree (customer_id)
CREATE INDEX invoices_status_idx ON public.invoices USING btree (status)
CREATE UNIQUE INDEX invoices_estimate_id_unique ON public.invoices USING btree (estimate_id) WHERE (estimate_id IS NOT NULL)
CREATE INDEX idx_invoices_share_token ON public.invoices USING btree (share_token) WHERE (share_token IS NOT NULL)
CREATE INDEX idx_invoices_accounting_ext ON public.invoices USING btree (accounting_external_id) WHERE (accounting_external_id IS NOT NULL)
CREATE INDEX idx_invoices_org_created ON public.invoices USING btree (organization_id, created_at DESC)
CREATE UNIQUE INDEX job_inspections_pkey ON public.job_inspections USING btree (id)
CREATE INDEX idx_job_inspections_job ON public.job_inspections USING btree (job_id)
CREATE INDEX idx_job_inspections_org_position ON public.job_inspections USING btree (organization_id, job_id, "position")
CREATE UNIQUE INDEX job_subcontractors_pkey ON public.job_subcontractors USING btree (job_id, subcontractor_id)
CREATE UNIQUE INDEX job_tasks_pkey ON public.job_tasks USING btree (id)
CREATE INDEX idx_job_tasks_job ON public.job_tasks USING btree (job_id)
CREATE INDEX idx_job_tasks_org_position ON public.job_tasks USING btree (organization_id, job_id, "position")
CREATE UNIQUE INDEX job_views_pkey ON public.job_views USING btree (user_id, job_id)
CREATE UNIQUE INDEX jobs_pkey ON public.jobs USING btree (id)
CREATE INDEX idx_jobs_org_type_created ON public.jobs USING btree (organization_id, type, created_at DESC)
CREATE UNIQUE INDEX lawn_jobs_pkey ON public.lawn_jobs USING btree (id)
CREATE INDEX idx_lawn_jobs_org ON public.lawn_jobs USING btree (organization_id)
CREATE UNIQUE INDEX lawn_services_pkey ON public.lawn_services USING btree (id)
CREATE INDEX idx_lawn_services_org ON public.lawn_services USING btree (organization_id, active)
CREATE UNIQUE INDEX lawn_visits_pkey ON public.lawn_visits USING btree (id)
CREATE INDEX idx_lawn_visits_schedule ON public.lawn_visits USING btree (recurring_schedule_id)
CREATE INDEX idx_lawn_visits_org_due ON public.lawn_visits USING btree (organization_id, due_date)
CREATE INDEX idx_lawn_visits_status ON public.lawn_visits USING btree (status)
CREATE UNIQUE INDEX uniq_lawn_visits_schedule_due ON public.lawn_visits USING btree (recurring_schedule_id, due_date)
CREATE INDEX idx_lawn_visits_notified ON public.lawn_visits USING btree (notified_at) WHERE (notified_at IS NOT NULL)
CREATE INDEX idx_lawn_visits_unbilled ON public.lawn_visits USING btree (organization_id) WHERE ((status = 'done'::text) AND (invoice_id IS NULL))
CREATE INDEX idx_lawn_visits_route_order ON public.lawn_visits USING btree (due_date, crew_id, route_order)
CREATE INDEX idx_lawn_visits_share_token ON public.lawn_visits USING btree (share_token)
CREATE INDEX idx_lawn_visits_notified_skipped ON public.lawn_visits USING btree (notified_skipped_at) WHERE (notified_skipped_at IS NOT NULL)
CREATE UNIQUE INDEX leads_pkey ON public.leads USING btree (id)
CREATE INDEX idx_leads_org_status ON public.leads USING btree (organization_id, status)
CREATE INDEX idx_leads_org_created ON public.leads USING btree (organization_id, created_at DESC)
CREATE UNIQUE INDEX notification_log_pkey ON public.notification_log USING btree (id)
CREATE INDEX notification_log_org_created_idx ON public.notification_log USING btree (organization_id, created_at DESC)
CREATE UNIQUE INDEX notification_settings_pkey ON public.notification_settings USING btree (organization_id)
CREATE UNIQUE INDEX notification_templates_pkey ON public.notification_templates USING btree (id)
CREATE UNIQUE INDEX notification_templates_organization_id_event_channel_key ON public.notification_templates USING btree (organization_id, event, channel)
CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id)
CREATE UNIQUE INDEX notifications_type_entity_key ON public.notifications USING btree (type, entity_id)
CREATE INDEX notifications_org_unread_idx ON public.notifications USING btree (organization_id, created_at DESC) WHERE (read_at IS NULL)
CREATE UNIQUE INDEX organizations_pkey ON public.organizations USING btree (id)
CREATE UNIQUE INDEX organizations_stripe_customer_id_key ON public.organizations USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)
CREATE UNIQUE INDEX organizations_stripe_connect_account_id_key ON public.organizations USING btree (stripe_connect_account_id) WHERE (stripe_connect_account_id IS NOT NULL)
CREATE UNIQUE INDEX organizations_lead_form_token_key ON public.organizations USING btree (lead_form_token)
CREATE UNIQUE INDEX password_resets_pkey ON public.password_resets USING btree (id)
CREATE UNIQUE INDEX password_resets_token_hash_idx ON public.password_resets USING btree (token_hash)
CREATE UNIQUE INDEX payments_pkey ON public.payments USING btree (id)
CREATE INDEX payments_invoice_id_idx ON public.payments USING btree (invoice_id)
CREATE INDEX payments_org_paid_at_idx ON public.payments USING btree (organization_id, paid_at)
CREATE UNIQUE INDEX photos_pkey ON public.photos USING btree (id)
CREATE INDEX photos_job_id_created_at_idx ON public.photos USING btree (job_id, created_at DESC)
CREATE INDEX idx_photos_visit ON public.photos USING btree (visit_id)
CREATE INDEX idx_photos_daily_log ON public.photos USING btree (daily_log_id) WHERE (daily_log_id IS NOT NULL)
CREATE INDEX idx_photos_punch_item ON public.photos USING btree (punch_item_id) WHERE (punch_item_id IS NOT NULL)
CREATE INDEX photos_install_id_idx ON public.photos USING btree (install_id)
CREATE UNIQUE INDEX portal_approvals_pkey ON public.portal_approvals USING btree (id)
CREATE INDEX idx_portal_approvals_doc ON public.portal_approvals USING btree (document_type, document_id)
CREATE UNIQUE INDEX portal_messages_pkey ON public.portal_messages USING btree (id)
CREATE INDEX idx_portal_messages_customer ON public.portal_messages USING btree (customer_id, created_at DESC)
CREATE INDEX idx_portal_messages_org_unread ON public.portal_messages USING btree (organization_id, read_at) WHERE (read_at IS NULL)
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id)
CREATE INDEX idx_profiles_org_full_name ON public.profiles USING btree (organization_id, full_name)
CREATE UNIQUE INDEX punch_items_pkey ON public.punch_items USING btree (id)
CREATE INDEX idx_punch_items_job ON public.punch_items USING btree (job_id)
CREATE INDEX idx_punch_items_org_status ON public.punch_items USING btree (organization_id, status)
CREATE INDEX idx_punch_items_assigned ON public.punch_items USING btree (assigned_to) WHERE (assigned_to IS NOT NULL)
CREATE UNIQUE INDEX receipts_pkey ON public.receipts USING btree (id)
CREATE INDEX receipts_job_id_idx ON public.receipts USING btree (job_id)
CREATE INDEX receipts_cost_code_id_idx ON public.receipts USING btree (cost_code_id)
CREATE INDEX idx_receipts_org_captured ON public.receipts USING btree (organization_id, captured_at DESC)
CREATE UNIQUE INDEX recurring_schedules_pkey ON public.recurring_schedules USING btree (id)
CREATE INDEX idx_recurring_schedules_job ON public.recurring_schedules USING btree (job_id)
CREATE INDEX idx_recurring_schedules_org ON public.recurring_schedules USING btree (organization_id, active)
CREATE UNIQUE INDEX review_requests_pkey ON public.review_requests USING btree (id)
CREATE UNIQUE INDEX review_requests_token_key ON public.review_requests USING btree (token)
CREATE INDEX idx_review_requests_org ON public.review_requests USING btree (organization_id, created_at DESC)
CREATE INDEX idx_review_requests_token ON public.review_requests USING btree (token)
CREATE UNIQUE INDEX rfis_pkey ON public.rfis USING btree (id)
CREATE UNIQUE INDEX route_optimizations_log_pkey ON public.route_optimizations_log USING btree (id)
CREATE INDEX idx_route_opt_log_org_day ON public.route_optimizations_log USING btree (organization_id, created_at)
CREATE UNIQUE INDEX schedule_events_pkey ON public.schedule_events USING btree (id)
CREATE INDEX idx_schedule_events_job ON public.schedule_events USING btree (job_id)
CREATE INDEX idx_schedule_events_org_start ON public.schedule_events USING btree (organization_id, start_at)
CREATE UNIQUE INDEX subcontractor_attachments_pkey ON public.subcontractor_attachments USING btree (id)
CREATE UNIQUE INDEX subcontractors_pkey ON public.subcontractors USING btree (id)
CREATE INDEX idx_subcontractors_org_company ON public.subcontractors USING btree (organization_id, company)
CREATE UNIQUE INDEX submittal_files_pkey ON public.submittal_files USING btree (id)
CREATE INDEX idx_submittal_files_submittal ON public.submittal_files USING btree (submittal_id)
CREATE UNIQUE INDEX submittals_pkey ON public.submittals USING btree (id)
CREATE INDEX idx_submittals_job ON public.submittals USING btree (job_id)
CREATE INDEX idx_submittals_org_status ON public.submittals USING btree (organization_id, status)
CREATE UNIQUE INDEX idx_submittals_number_org ON public.submittals USING btree (submittal_number, organization_id) WHERE (submittal_number IS NOT NULL)
CREATE UNIQUE INDEX idx_submittals_share_token ON public.submittals USING btree (share_token) WHERE (share_token IS NOT NULL)
CREATE UNIQUE INDEX time_entries_pkey ON public.time_entries USING btree (id)
CREATE INDEX time_entries_user_id_idx ON public.time_entries USING btree (user_id)
CREATE INDEX time_entries_job_id_idx ON public.time_entries USING btree (job_id)
CREATE INDEX time_entries_open_idx ON public.time_entries USING btree (clock_in_at) WHERE (clock_out_at IS NULL)
CREATE INDEX idx_time_entries_status ON public.time_entries USING btree (organization_id, status) WHERE (status <> 'approved'::text)
CREATE INDEX idx_time_entries_user_clock ON public.time_entries USING btree (user_id, clock_in_at DESC)

-- ============================================================ FUNCTIONS ============================================================
CREATE OR REPLACE FUNCTION public.ai_action_max(p_plan text, p_trial timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_eff text;
begin
  v_eff := p_plan;
  if p_plan = 'trial' and p_trial is not null and now() > p_trial then
    v_eff := 'expired';
  end if;

  return case v_eff
    when 'trial'                       then 25
    when 'free'                        then 0
    when 'pro'                         then 100
    when 'enterprise'                  then 5000
    when 'starter'                     then 0
    when 'expired'                     then 0
    when 'canceled'                    then 0
    else 0
  end;
end;
$function$


CREATE OR REPLACE FUNCTION public.approve_estimate(p_estimate_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer_id    uuid;
  v_job_id         uuid;
  v_org            uuid;
  v_job_type       text;
  v_invoice_id     uuid;
  v_subtotal       numeric(12,2) := 0;
  v_markup_pct     numeric(5,2)  := 0;
  v_cont_pct       numeric(5,2)  := 0;
  v_tax_pct        numeric(5,2)  := 0;
  v_markup_amt     numeric(12,2) := 0;
  v_cont_amt       numeric(12,2) := 0;
  v_pretax         numeric(12,2) := 0;
  v_tax_amt        numeric(12,2) := 0;
  v_grand_total    numeric(12,2) := 0;
  v_deposit_pct    numeric(5,2)  := 0;
  v_deposit_amt    numeric(12,2) := 0;
  v_deposit        numeric(12,2) := 0;
  v_pos            integer       := 0;
begin
  -- jobs.type via left join (standalone, job-less estimates → null → treated
  -- as construction, which is correct: lawn jobs always have a job_id).
  select e.customer_id, e.job_id, e.organization_id, j.type,
         coalesce(e.markup_pct, 0), coalesce(e.contingency_pct, 0), coalesce(e.tax_pct, 0),
         coalesce(e.deposit_pct, 0), coalesce(e.deposit_amount, 0)
    into v_customer_id, v_job_id, v_org, v_job_type, v_markup_pct, v_cont_pct, v_tax_pct,
         v_deposit_pct, v_deposit_amt
  from public.estimates e
  left join public.jobs j on j.id = e.job_id
  where e.id = p_estimate_id;

  if v_customer_id is null then
    raise exception 'Estimate not found';
  end if;

  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to approve this estimate';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: estimate belongs to another organization';
  end if;

  if not exists (select 1 from public.estimates where id = p_estimate_id and status = 'sent') then
    raise exception 'Estimate is not awaiting approval';
  end if;

  if exists (select 1 from public.invoices where estimate_id = p_estimate_id) then
    raise exception 'Estimate already approved';
  end if;

  -- Flip the estimate to approved regardless of job type.
  update public.estimates
  set status = 'approved', approved_at = now(), updated_at = now()
  where id = p_estimate_id;

  -- Lawn jobs are billed by monthly cycle billing — approving creates NO
  -- invoice (return null) so the customer isn't double-billed.
  if coalesce(v_job_type, 'construction') = 'lawn' then
    return null;
  end if;

  -- Construction: compute the deposit (explicit $ when > 0, else % of grand
  -- total) — same math as the estimate doc + the decide route.
  select coalesce(sum(e.quantity * e.unit_price), 0) into v_subtotal
  from public.estimate_line_items e
  where e.estimate_id = p_estimate_id;

  if v_markup_pct > 0 then
    v_markup_amt := round(v_subtotal * v_markup_pct / 100.0, 2);
  end if;
  if v_cont_pct > 0 then
    v_cont_amt := round(v_subtotal * v_cont_pct / 100.0, 2);
  end if;
  v_pretax := v_subtotal + v_markup_amt + v_cont_amt;
  if v_tax_pct > 0 then
    v_tax_amt := round(v_pretax * v_tax_pct / 100.0, 2);
  end if;
  v_grand_total := v_pretax + v_tax_amt;

  if v_deposit_amt > 0 then
    v_deposit := round(v_deposit_amt, 2);
  elsif v_deposit_pct > 0 then
    v_deposit := round(v_grand_total * v_deposit_pct / 100.0, 2);
  end if;

  -- Deposit-only invoice: amount_paid 0 (the deposit is owed, not pre-paid).
  -- trg_invoices_org stamps organization_id from the job (or the parent
  -- estimate for standalone, job-less estimates).
  insert into public.invoices (estimate_id, job_id, customer_id, status, amount_paid)
  values (p_estimate_id, v_job_id, v_customer_id, 'sent', 0)
  returning id into v_invoice_id;

  if v_deposit > 0 then
    -- Single deposit line — the invoice total IS the deposit to start work.
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    values (v_invoice_id, 'Deposit to start work', 1, v_deposit, 0);
  else
    -- No deposit split → full-total invoice: snapshot the line items + the
    -- pricing-summary lines so the invoice total == estimate grand total.
    insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
    select
      v_invoice_id,
      coalesce(e.description, cc.name, ''),
      e.quantity,
      e.unit_price,
      e.position
    from public.estimate_line_items e
    left join public.cost_codes cc on cc.id = e.cost_code_id
    where e.estimate_id = p_estimate_id
    order by e.position;

    select coalesce(max(position), 0) into v_pos
    from public.invoice_line_items
    where invoice_id = v_invoice_id;

    if v_markup_pct > 0 then
      v_pos := v_pos + 1;
      insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
      values (v_invoice_id, 'Overhead & Profit (' || v_markup_pct || '%)', 1, v_markup_amt, v_pos);
    end if;

    if v_cont_pct > 0 then
      v_pos := v_pos + 1;
      insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
      values (v_invoice_id, 'Contingency (' || v_cont_pct || '%)', 1, v_cont_amt, v_pos);
    end if;

    if v_tax_pct > 0 then
      v_pos := v_pos + 1;
      insert into public.invoice_line_items (invoice_id, description, quantity, unit_price, position)
      values (v_invoice_id, 'Sales Tax (' || v_tax_pct || '%)', 1, v_tax_amt, v_pos);
    end if;
  end if;

  return v_invoice_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.assign_job_crew(p_job_id uuid, p_crew uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
begin
  if not (public.is_office_or_pm(auth.uid()) or public.is_super_admin(auth.uid())) then
    raise exception 'Not authorized to assign crew';
  end if;

  select organization_id into v_org from public.jobs where id = p_job_id;
  if v_org is null then
    raise exception 'Job not found';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: job belongs to another organization';
  end if;

  update public.jobs set assigned_crew = p_crew where id = p_job_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.check_ai_quota(p_org uuid)
 RETURNS TABLE(allowed boolean, used integer, max integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan  text;
  v_trial timestamptz;
  v_max   int;
  v_used  int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    -- Unknown org: deny (no quota to spend).
    return query select false, 0, 0;
    return;
  end if;

  v_max := public.ai_action_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.ai_action_log
    where organization_id = p_org
      and created_at >= date_trunc('month', now());

  return query select (v_max is null or v_used < v_max), v_used, v_max;
end;
$function$


CREATE OR REPLACE FUNCTION public.check_route_opt_quota(p_org uuid)
 RETURNS TABLE(allowed boolean, used integer, max integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan  text;
  v_trial timestamptz;
  v_max   int;
  v_used  int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    -- Unknown org: deny (no quota to spend).
    return query select false, 0, 0;
    return;
  end if;

  v_max := public.route_opt_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.route_optimizations_log
    where organization_id = p_org
      and created_at >= date_trunc('day', now());

  return query select (v_max is null or v_used < v_max), v_used, v_max;
end;
$function$


CREATE OR REPLACE FUNCTION public.decide_change_order(p_co_id uuid, p_decision text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_co        public.change_orders%rowtype;
  v_customer  uuid;
  v_job_cust  uuid;
  v_cust_name text;
  v_job_name  text;
  v_type      text;
  v_title     text;
begin
  select * into v_co from public.change_orders where id = p_co_id;
  if not found then
    raise exception 'Change order not found';
  end if;
  if v_co.status <> 'sent' then
    raise exception 'This change order is not awaiting action';
  end if;
  if p_decision not in ('approve','reject') then
    raise exception 'decision must be ''approve'' or ''reject''';
  end if;

  select customer_id into v_customer from public.profiles where id = auth.uid();
  if v_customer is null then
    raise exception 'Only customer accounts may decide change orders';
  end if;

  -- change_orders has no customer_id column; resolve via the job.
  select customer_id into v_job_cust from public.jobs where id = v_co.job_id;
  if v_job_cust is null or v_job_cust is distinct from v_customer then
    raise exception 'Not authorized to decide this change order';
  end if;
  if not public.same_org(auth.uid(), v_co.organization_id) then
    raise exception 'Not authorized: change order belongs to another organization';
  end if;

  if p_decision = 'approve' then
    update public.change_orders
      set status = 'approved', approved_at = now(), updated_at = now()
      where id = p_co_id;
  else
    update public.change_orders
      set status = 'rejected', rejected_at = now(), updated_at = now()
      where id = p_co_id;
  end if;

  -- Best-effort office feed notification (matches the /co/{token} decide route).
  select name into v_cust_name from public.customers where id = v_customer;
  select name into v_job_name  from public.jobs     where id = v_co.job_id;
  v_type  := case when p_decision = 'approve' then 'change_order_approved' else 'change_order_rejected' end;
  v_title := case when p_decision = 'approve' then 'Change order approved'  else 'Change order rejected'  end;
  insert into public.notifications (organization_id, type, title, body, href, entity_id)
  values (v_co.organization_id, v_type, v_title,
          concat_ws(' · ', v_cust_name, v_job_name),
          '/change-orders/' || p_co_id::text, p_co_id)
  on conflict (type, entity_id) do nothing;
end;
$function$


CREATE OR REPLACE FUNCTION public.get_my_tenant()
 RETURNS TABLE(role text, organization_id uuid, has_profile boolean, is_super_admin boolean, org_name text, plan text, plan_status text, trial_ends_at timestamp with time zone, app_variant text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid       uuid := auth.uid();
  p_role    text;
  p_org     uuid;
  o_name    text;
  o_plan    text;
  o_status  text;
  o_trial   timestamptz;
  o_variant text;
begin
  if uid is null then
    return;  -- not authenticated, zero rows (client treats as signed-out)
  end if;

  select role, organization_id
    into p_role, p_org
  from public.profiles
  where id = uid;

  -- Skip the org read when there is no org to read. Keys off orgId (not role),
  -- matching getMe(): orgId null -> NO_ORG. A super_admin that still has an
  -- org_id (legacy) resolves its org row too, same as the old code.
  if p_org is not null then
    select name, plan, plan_status, trial_ends_at, app_variant
      into o_name, o_plan, o_status, o_trial, o_variant
    from public.organizations
    where id = p_org;
  end if;

  -- role is returned raw (null when no profile row); the client applies the
  -- "crew" fallback. has_profile distinguishes a real crew user from an
  -- incomplete signup (both role "crew" after the fallback).
  return query select
    p_role,
    p_org,
    (p_role is not null) as has_profile,
    (p_role = 'super_admin') as is_super_admin,
    o_name,
    o_plan,
    o_status,
    o_trial,
    o_variant;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_crew_member_create()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan    text;
  v_status  text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_count   bigint;
  v_max     int;
begin
  select plan, plan_status, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_status, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow adding crew members. Subscribe to continue.';
  end if;

  -- Past-due subscription: block new crew members until billing is updated.
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume adding crew members.';
  end if;

  -- Max crew_members per tier per variant (mirror src/lib/plans.ts maxCrewMembers).
  v_max := case
    when v_eff = 'trial'     then null
    when v_eff = 'free'      then 3
    when v_eff = 'enterprise' then null
    when v_eff = 'pro'        then (case when v_variant = 'lawn' then 150 else 100 end)
    when v_eff = 'starter'    then (case when v_variant = 'lawn' then 25 else 15 end)
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.crew_members
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Crew member limit reached (%) on the % plan. Upgrade to add more crew.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_customer_create()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan    text;
  v_status  text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_count   bigint;
  v_max     int;
begin
  select plan, plan_status, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_status, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow adding customers. Subscribe to continue.';
  end if;

  -- Past-due subscription: block new customers until billing is updated.
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume adding customers.';
  end if;

  -- Max customers per tier per variant (mirror src/lib/plans.ts maxCustomers).
  v_max := case
    when v_eff = 'trial'      then null
    when v_eff = 'free'       then 25
    when v_eff = 'enterprise' then null
    when v_eff = 'pro'        then (case when v_variant = 'lawn' then 1000 else 500 end)
    when v_eff = 'starter'    then (case when v_variant = 'lawn' then 100 else 50 end)
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.customers
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Customer limit reached (%) on the % plan. Upgrade to add more customers.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_job_create()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan     text;
  v_status   text;
  v_trial    timestamptz;
  v_variant  text;
  v_eff      text;
  v_count    bigint;
  v_max      int;
begin
  select plan, plan_status, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_status, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  -- Effective plan (lazy trial expiry, same as billing.ts effectiveStatus).
  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow new jobs. Subscribe to continue.';
  end if;

  -- Past-due subscription: a Stripe payment is retrying. Block new jobs until
  -- billing info is updated (matches src/lib/billing.ts createGate past_due).
  if v_status = 'past_due' then
    raise exception 'Your subscription payment is past due. Update your billing info to resume creating jobs.';
  end if;

  -- Max jobs per tier per variant (mirror src/lib/plans.ts maxJobs).
  v_max := case
    when v_eff = 'trial'     then null
    when v_eff = 'free'      then 25
    when v_eff = 'enterprise' then (case when v_variant = 'lawn' then 500 else null end)
    when v_eff = 'pro'        then (case when v_variant = 'lawn' then 150 else 50 end)
    when v_eff = 'starter'    then (case when v_variant = 'lawn' then 25 else 10 end)
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.jobs
      where organization_id = new.organization_id;
    if v_count >= v_max then
      raise exception 'Job limit reached (%) on the % plan. Upgrade to add more jobs.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_jobs_variant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org_variant text;
begin
  -- Look up the owning org's variant. SECURITY DEFINER runs as the owner
  -- (postgres), bypassing RLS so this read always succeeds.
  select app_variant
    into v_org_variant
  from public.organizations
  where id = new.organization_id;

  -- If the org doesn't exist yet, let the foreign-key / other constraints
  -- handle it rather than failing here.
  if not found then
    return new;
  end if;

  -- Lawn orgs cannot create or switch to a construction job. Construction
  -- orgs may still create lawn jobs (one-directional by design).
  if v_org_variant = 'lawn' and new.type = 'construction' then
    raise exception 'Lawn organizations cannot create construction jobs'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_lawn_visit_crew_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_is_office boolean;
begin
  -- tier_office_or_pm(organization_id) checks the CALLER's role in this org,
  -- exactly like the "Office manage lawn visits" WITH CHECK.
  select public.tier_office_or_pm(NEW.organization_id) into v_is_office;
  if not v_is_office then
    if NEW.due_date is distinct from OLD.due_date
       or NEW.job_id is distinct from OLD.job_id
       or NEW.recurring_schedule_id is distinct from OLD.recurring_schedule_id
       or NEW.crew_id is distinct from OLD.crew_id
       or NEW.organization_id is distinct from OLD.organization_id
       or NEW.scheduled_window_start is distinct from OLD.scheduled_window_start
       or NEW.scheduled_window_end is distinct from OLD.scheduled_window_end then
      raise exception 'Crew may only update status/completed_at/notes/started_at on lawn_visits'
        using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_profile_create()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan    text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_count   bigint;
  v_max     int;
begin
  -- Customers (Client Portal invites) are not app-user seats.
  if new.role = 'customer' then
    return new;
  end if;

  select plan, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_trial, v_variant
    from public.organizations
    where id = new.organization_id;
  if not found then
    return new;
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  if v_eff in ('expired', 'canceled') then
    raise exception 'Your plan does not allow adding users. Subscribe to continue.';
  end if;

  -- maxUsers (mirror src/lib/plans.ts). construction enterprise = unlimited.
  v_max := case
    when v_eff = 'trial'                       then null
    when v_eff = 'enterprise' and v_variant = 'lawn'  then 75
    when v_eff = 'enterprise'                       then null
    when v_eff = 'pro'                              then 25
    when v_eff = 'starter'                          then 5
    else null
  end;

  if v_max is not null then
    select count(*) into v_count
      from public.profiles
      where organization_id = new.organization_id
        and role <> 'customer';
    if v_count >= v_max then
      raise exception 'Seat limit reached (%s) on the %s plan. Upgrade to add more users.',
        v_max, v_eff;
    end if;
  end if;

  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.guard_storage_object()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org     uuid;
  v_size    bigint;
  v_plan    text;
  v_trial   timestamptz;
  v_variant text;
  v_eff     text;
  v_used    bigint;
  v_max     bigint;
begin
  v_org := public.storage_object_org(new.name, new.bucket_id);
  if v_org is null then
    return new;
  end if;
  v_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  if v_size <= 0 then
    return new;
  end if;

  select plan, trial_ends_at, coalesce(app_variant, 'construction')
    into v_plan, v_trial, v_variant
    from public.organizations
    where id = v_org;
  if not found then
    return new;
  end if;

  -- Effective plan (lazy trial expiry, mirrors guard_job_create / billing.ts).
  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  -- maxStorageBytes (mirror src/lib/plans.ts). GB = 1024^3. null = unlimited/no-block.
  -- enterprise (Business) is intentionally null here = SOFT cap: tracked, never
  -- blocked (see the competitive-choice note at the top of this file). The
  -- counter still increments so usage can be monitored/alerted nightly.
  -- pro is variant-aware: lawn 75GB (before/after photos), construction 25GB.
  v_max := case
    when v_eff = 'trial'                       then null
    when v_eff = 'free'                            then 1::bigint  * 1024 * 1024 * 1024
    when v_eff = 'enterprise'                       then null
    when v_eff = 'pro' and v_variant = 'lawn'       then 75::bigint * 1024 * 1024 * 1024
    when v_eff = 'pro'                              then 25::bigint * 1024 * 1024 * 1024
    when v_eff = 'starter'                          then 5::bigint  * 1024 * 1024 * 1024
    when v_eff in ('expired', 'canceled')           then 0::bigint
    else null
  end;

  if v_max is not null then
    select storage_bytes into v_used from public.organizations where id = v_org;
    if coalesce(v_used, 0) + v_size > v_max then
      raise exception 'Storage limit reached (%s) on the %s plan. Remove files or upgrade to upload more.',
        pg_size_pretty(v_max), v_eff;
    end if;
  end if;

  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_add_note(p_install_id uuid, p_body text)
 RETURNS install_notes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_install public.installs := public.install_authorize(p_install_id);
  v_note    public.install_notes;
begin
  if length(btrim(coalesce(p_body, ''))) = 0 then
    raise exception 'Note cannot be empty' using errcode = '22023';
  end if;
  insert into public.install_notes (organization_id, install_id, author_id, body)
  values (v_install.organization_id, p_install_id, auth.uid(), btrim(p_body))
  returning * into v_note;
  return v_note;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_authorize(p_install_id uuid)
 RETURNS installs
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_install public.installs;
begin
  select * into v_install from public.installs where id = p_install_id;
  if not found then
    raise exception 'Install not found' using errcode = '42704';
  end if;
  if not (
    auth.uid() = any (v_install.assigned_crew)
    or public.tier_office_or_pm(v_install.organization_id)
  ) then
    raise exception 'Not authorized for this install' using errcode = '42501';
  end if;
  return v_install;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_complete(p_install_id uuid, p_outcome text DEFAULT 'completed'::text, p_note text DEFAULT NULL::text)
 RETURNS installs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_install public.installs := public.install_authorize(p_install_id);
  v_outcome text := lower(coalesce(nullif(btrim(p_outcome), ''), 'completed'));
begin
  if v_install.status = 'cancelled' then
    raise exception 'This install was cancelled' using errcode = '22023';
  end if;
  if v_outcome not in ('completed','partial','could_not_complete') then
    raise exception 'Outcome must be completed, partial, or could_not_complete' using errcode = '22023';
  end if;
  update public.install_time_entries set ended_at = now()
   where install_id = p_install_id and ended_at is null;
  if length(btrim(coalesce(p_note, ''))) > 0 then
    insert into public.install_notes (organization_id, install_id, author_id, body)
    values (v_install.organization_id, p_install_id, auth.uid(), btrim(p_note));
  end if;
  update public.installs
     set completion_outcome = v_outcome,
         status = case when v_outcome = 'completed' then 'completed' else 'needs_followup' end,
         completed_at = case when v_outcome = 'completed' then coalesce(completed_at, now()) else null end,
         started_at = coalesce(started_at, now())
   where id = p_install_id
  returning * into v_install;
  return v_install;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_log_material(p_install_id uuid, p_name text, p_quantity numeric DEFAULT NULL::numeric, p_unit text DEFAULT NULL::text, p_serial_number text DEFAULT NULL::text)
 RETURNS install_materials
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_install  public.installs := public.install_authorize(p_install_id);
  v_material public.install_materials;
begin
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Material name is required' using errcode = '22023';
  end if;
  if p_quantity is not null and p_quantity < 0 then
    raise exception 'Quantity cannot be negative' using errcode = '22023';
  end if;
  insert into public.install_materials
    (organization_id, install_id, name, quantity, unit, serial_number, added_by)
  values (v_install.organization_id, p_install_id, btrim(p_name), p_quantity,
          nullif(btrim(coalesce(p_unit, '')), ''),
          nullif(btrim(coalesce(p_serial_number, '')), ''),
          auth.uid())
  returning * into v_material;
  return v_material;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_report_problem(p_install_id uuid, p_description text, p_severity text DEFAULT 'normal'::text)
 RETURNS install_issues
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_install public.installs := public.install_authorize(p_install_id);
  v_issue   public.install_issues;
  v_sev     text := lower(coalesce(nullif(btrim(p_severity), ''), 'normal'));
begin
  if length(btrim(coalesce(p_description, ''))) = 0 then
    raise exception 'Describe the problem before submitting' using errcode = '22023';
  end if;
  if v_sev not in ('low','normal','high') then
    raise exception 'Severity must be low, normal, or high' using errcode = '22023';
  end if;
  insert into public.install_issues (organization_id, install_id, reported_by, description, severity)
  values (v_install.organization_id, p_install_id, auth.uid(), btrim(p_description), v_sev)
  returning * into v_issue;
  return v_issue;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_start(p_install_id uuid)
 RETURNS installs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_install public.installs := public.install_authorize(p_install_id);
begin
  if v_install.status = 'cancelled' then
    raise exception 'This install was cancelled' using errcode = '22023';
  end if;
  if v_install.status = 'completed' then
    raise exception 'This install is already complete' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.install_time_entries
    where install_id = p_install_id and user_id = auth.uid() and ended_at is null
  ) then
    insert into public.install_time_entries (organization_id, install_id, user_id)
    values (v_install.organization_id, p_install_id, auth.uid());
  end if;
  update public.installs
     set status     = case when status in ('scheduled','needs_followup') then 'in_progress' else status end,
         started_at = coalesce(started_at, now())
   where id = p_install_id
  returning * into v_install;
  return v_install;
end;
$function$


CREATE OR REPLACE FUNCTION public.install_stop(p_install_id uuid)
 RETURNS installs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_install public.installs := public.install_authorize(p_install_id);
begin
  update public.install_time_entries
     set ended_at = now()
   where install_id = p_install_id and user_id = auth.uid() and ended_at is null;
  return v_install;
end;
$function$


CREATE OR REPLACE FUNCTION public.is_accountant(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('accountant', 'office', 'admin')
  );
$function$


CREATE OR REPLACE FUNCTION public.is_management(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin', 'superintendent', 'project_manager')
  );
$function$


CREATE OR REPLACE FUNCTION public.is_office(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin')
  );
$function$


CREATE OR REPLACE FUNCTION public.is_office_or_pm(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('office', 'admin', 'project_manager')
  );
$function$


CREATE OR REPLACE FUNCTION public.is_pipeline(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = uid and role in ('sales', 'project_manager', 'office', 'admin')
  );
$function$


CREATE OR REPLACE FUNCTION public.is_super_admin(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = uid and role = 'super_admin' and organization_id is null
  );
$function$


CREATE OR REPLACE FUNCTION public.lawn_visit_assigned_to(p_job_id uuid, p_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.lawn_visits lv
    where lv.job_id = p_job_id and lv.crew_id = p_uid
  );
$function$


CREATE OR REPLACE FUNCTION public.my_org_id(uid uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select organization_id from public.profiles where id = uid;
$function$


CREATE OR REPLACE FUNCTION public.reconcile_org_storage(p_org uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
declare
  v_total bigint;
begin
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0) into v_total
  from storage.objects o
  where public.storage_object_org(o.name, o.bucket_id) = p_org;

  update public.organizations
    set storage_bytes = v_total
    where id = p_org;

  return v_total;
end;
$function$


CREATE OR REPLACE FUNCTION public.record_ai_action(p_org uuid, p_profile uuid, p_feature text, p_tokens_in integer DEFAULT 0, p_tokens_out integer DEFAULT 0, p_cost_cents integer DEFAULT 0)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan     text;
  v_trial    timestamptz;
  v_eff      text;
  v_max      int;
  v_used     int;
  v_remain   int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    raise exception 'Unknown organization for AI action.';
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  v_max := public.ai_action_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.ai_action_log
    where organization_id = p_org
      and created_at >= date_trunc('month', now());

  if v_max is not null and v_used >= v_max then
    raise exception 'AI action limit reached (%) on the %s plan this month. Upgrade for more.',
      v_max, v_eff;
  end if;

  insert into public.ai_action_log
    (organization_id, profile_id, feature, tokens_in, tokens_out, cost_cents)
  values
    (p_org, p_profile, p_feature, p_tokens_in, p_tokens_out, p_cost_cents);

  v_remain := case when v_max is null then -1 else (v_max - v_used - 1) end;
  return v_remain;
end;
$function$


CREATE OR REPLACE FUNCTION public.record_route_opt(p_org uuid, p_profile uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_plan   text;
  v_trial  timestamptz;
  v_eff    text;
  v_max    int;
  v_used   int;
  v_remain int;
begin
  select plan, trial_ends_at
    into v_plan, v_trial
    from public.organizations
    where id = p_org;
  if not found then
    raise exception 'Unknown organization for route optimization.';
  end if;

  v_eff := v_plan;
  if v_plan = 'trial' and v_trial is not null and now() > v_trial then
    v_eff := 'expired';
  end if;

  v_max := public.route_opt_max(v_plan, v_trial);

  select count(*)::int into v_used
    from public.route_optimizations_log
    where organization_id = p_org
      and created_at >= date_trunc('day', now());

  if v_max is not null and v_used >= v_max then
    raise exception 'Route optimization limit reached (%) on the %s plan today. Upgrade for unlimited.',
      v_max, v_eff;
  end if;

  insert into public.route_optimizations_log (organization_id, profile_id)
  values (p_org, p_profile);

  v_remain := case when v_max is null then -1 else (v_max - v_used - 1) end;
  return v_remain;
end;
$function$


CREATE OR REPLACE FUNCTION public.reject_estimate(p_estimate_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer_id uuid;
  v_org         uuid;
begin
  select e.customer_id, e.organization_id
    into v_customer_id, v_org
  from public.estimates e
  where e.id = p_estimate_id;

  if v_customer_id is null then
    raise exception 'Estimate not found';
  end if;

  if v_customer_id is distinct from (
    select customer_id from public.profiles where id = auth.uid()
  ) then
    raise exception 'Not authorized to reject this estimate';
  end if;
  if not public.same_org(auth.uid(), v_org) then
    raise exception 'Not authorized: estimate belongs to another organization';
  end if;

  if not exists (select 1 from public.estimates where id = p_estimate_id and status = 'sent') then
    raise exception 'Estimate is not awaiting action';
  end if;

  update public.estimates
  set status = 'rejected', rejected_at = now(), updated_at = now()
  where id = p_estimate_id;
end;
$function$


CREATE OR REPLACE FUNCTION public.route_opt_max(p_plan text, p_trial timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_eff text;
begin
  v_eff := p_plan;
  if p_plan = 'trial' and p_trial is not null and now() > p_trial then
    v_eff := 'expired';
  end if;

  return case v_eff
    when 'free'                        then 5
    when 'trial'                       then null  -- unlimited
    when 'starter'                     then null
    when 'pro'                         then null
    when 'enterprise'                  then null
    when 'expired'                     then 0
    when 'canceled'                    then 0
    else 0
  end;
end;
$function$


CREATE OR REPLACE FUNCTION public.same_org(uid uuid, org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_super_admin(uid)
      or (org_id is not null and org_id = public.my_org_id(uid));
$function$


CREATE OR REPLACE FUNCTION public.seed_notification_templates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.notification_templates (organization_id, event, channel, subject, body, active)
  select new.id, v.event, v.channel, v.subject, v.body, true
  from (values
    ('visit_reminder','email',
     E'Lawn service scheduled today — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is scheduled for today ({{service_date}}).\n\nThank you,\n{{org_name}}'),
    ('visit_reminder','sms', null,
     E'{{org_name}}: Lawn service for {{job_name}} is scheduled for today ({{service_date}}).'),
    ('on_my_way','email',
     E'Your lawn crew is on the way — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn crew is heading to {{job_name}} and should arrive shortly.\n\n{{org_name}}'),
    ('on_my_way','sms', null,
     E'{{org_name}}: Your lawn crew is on the way to {{job_name}}.'),
    ('service_complete','email',
     E'Lawn service complete — {{job_name}}',
     E'Hi {{customer_name}},\n\nYour lawn service for {{job_name}} is complete. View before/after photos:\n{{photo_link}}\n\nThank you,\n{{org_name}}'),
    ('service_complete','sms', null,
     E'{{org_name}}: Lawn service for {{job_name}} is complete. Photos: {{photo_link}}'),
    ('service_skipped','email',
     E'Lawn service visit skipped — {{job_name}}',
     E'Hi {{customer_name}},\n\nWe had to skip your scheduled lawn service for {{job_name}} on {{service_date}}. Reason: {{reason}}. We will reach out to reschedule.\n\nThank you,\n{{org_name}}'),
    ('service_skipped','sms', null,
     E'{{org_name}}: We skipped your {{service_date}} lawn service for {{job_name}} ({{reason}}). We will reach out to reschedule.'),
    ('review_request','email',
     E'How was your lawn service? — {{org_name}}',
     E'Hi {{customer_name}},\n\nThanks for choosing {{org_name}}. If you were happy with your lawn service for {{job_name}}, we would love a review:\n{{review_link}}\n\nThank you,'),
    ('review_request','sms', null,
     E'{{org_name}}: Enjoyed your service for {{job_name}}? Leave us a review: {{review_link}}')
  ) as v(event, channel, subject, body)
  on conflict (organization_id, event, channel) do nothing;
  return new;
end $function$


CREATE OR REPLACE FUNCTION public.set_org_from_change_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select organization_id into v_org from public.change_orders where id = new.change_order_id;
  if v_org is null then
    raise exception 'Cannot insert change_order_lines: parent change order % missing or no org', new.change_order_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_crew_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  if new.organization_id is null then
    select organization_id into v_org from public.profiles where id = auth.uid();
    if v_org is null then
      raise exception 'Cannot insert crew_members: no organization and caller has no profile org'
        using errcode = '23503';
    end if;
    new.organization_id := v_org;
  end if;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_customer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select organization_id into v_org from public.customers where id = new.customer_id;
  if v_org is null then
    raise exception 'Cannot insert portal_messages: customer % missing or no org', new.customer_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_estimate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select organization_id into v_org from public.estimates where id = new.estimate_id;
  if v_org is null then
    raise exception 'Cannot insert estimate_line_items: parent estimate % missing or no org', new.estimate_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select organization_id into v_org from public.invoices where id = new.invoice_id;
  if v_org is null then
    raise exception 'Cannot insert invoice_line_items: parent invoice % missing or no org', new.invoice_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.jobs where id = new.job_id;
  if v_org is null then
    raise exception 'Cannot insert %: parent job % not found or has no organization',
      TG_TABLE_NAME, new.job_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_job_or_estimate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select organization_id into v_org from public.jobs where id = new.job_id;
  elsif new.estimate_id is not null then
    select organization_id into v_org from public.estimates where id = new.estimate_id;
  end if;
  if v_org is null then
    raise exception 'Cannot insert invoices: no job and no parent estimate organization';
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_job_or_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select organization_id into v_org from public.jobs where id = new.job_id;
  else
    v_org := new.organization_id;
  end if;
  if v_org is null then
    raise exception 'Cannot insert %: no job and no organization_id supplied',
      TG_TABLE_NAME;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_photo_parent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  if new.job_id is not null then
    select organization_id into v_org from public.jobs where id = new.job_id;
  elsif new.install_id is not null then
    select organization_id into v_org from public.installs where id = new.install_id;
  elsif new.visit_id is not null then
    select organization_id into v_org from public.lawn_visits where id = new.visit_id;
  elsif new.daily_log_id is not null then
    select organization_id into v_org from public.daily_logs where id = new.daily_log_id;
  elsif new.punch_item_id is not null then
    select organization_id into v_org from public.punch_items where id = new.punch_item_id;
  end if;
  if v_org is null then
    raise exception 'Cannot insert photo: no resolvable parent (job, install, lawn visit, daily log, or punch item)'
      using errcode = '23503';
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_subcontractor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid;
begin
  select organization_id into v_org from public.subcontractors where id = new.subcontractor_id;
  if v_org is null then
    raise exception 'Cannot insert subcontractor_attachments: parent sub % missing or no org', new.subcontractor_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.set_org_from_template()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.estimate_templates where id = new.template_id;
  if v_org is null then
    raise exception 'Cannot insert estimate_template_items: parent template % missing or has no organization',
      new.template_id;
  end if;
  new.organization_id := v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.sign_proposal(p_estimate_id uuid, p_signature_text text, p_signature_image_path text, p_signer_name text, p_signer_ip inet)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_est        public.estimates%rowtype;
  v_customer   uuid;
  v_approval   uuid;
  v_cust_name  text;
  v_job_name   text;
begin
  select * into v_est from public.estimates where id = p_estimate_id;
  if not found then
    raise exception 'Proposal not found';
  end if;
  if v_est.status <> 'sent' then
    raise exception 'This proposal is not awaiting action';
  end if;
  if v_est.requires_signature is not true then
    raise exception 'This estimate is not configured for e-signature';
  end if;

  select customer_id into v_customer from public.profiles where id = auth.uid();
  if v_customer is null then
    raise exception 'Only customer accounts may sign proposals';
  end if;
  if v_est.customer_id is null or v_est.customer_id is distinct from v_customer then
    raise exception 'Not authorized to sign this proposal';
  end if;
  if not public.same_org(auth.uid(), v_est.organization_id) then
    raise exception 'Not authorized: proposal belongs to another organization';
  end if;
  if coalesce(p_signature_text, '') = '' then
    raise exception 'A typed signature is required';
  end if;

  insert into public.portal_approvals (
    organization_id, job_id, document_type, document_id, customer_id,
    signer_name, signature_text, signature_image_path, signer_ip, action
  ) values (
    v_est.organization_id, v_est.job_id, 'estimate', v_est.id, v_customer,
    p_signer_name, p_signature_text, p_signature_image_path, p_signer_ip, 'approved'
  )
  returning id into v_approval;

  update public.estimates
    set status = 'approved',
        approved_at = now(),
        updated_at = now()
    where id = p_estimate_id;

  -- Best-effort office feed notification (reuses the estimate_approved type so
  -- the unique (type, entity_id) index dedups a one-click + e-sign on the same
  -- estimate; the title distinguishes a signed proposal).
  select name into v_cust_name from public.customers where id = v_customer;
  select name into v_job_name  from public.jobs     where id = v_est.job_id;
  insert into public.notifications (organization_id, type, title, body, href, entity_id)
  values (
    v_est.organization_id, 'estimate_approved', 'Proposal signed',
    concat_ws(' · ', v_cust_name, v_job_name),
    '/estimates/' || p_estimate_id::text, p_estimate_id
  )
  on conflict (type, entity_id) do nothing;

  return v_approval;
end;
$function$


CREATE OR REPLACE FUNCTION public.storage_caller_assigned_to_install(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.installs i
    where split_part(p_name, '/', 1) = 'installs'
      and i.id::text = split_part(p_name, '/', 2)
      and auth.uid() = any (i.assigned_crew)
      and public.same_org(auth.uid(), i.organization_id)
  );
$function$


CREATE OR REPLACE FUNCTION public.storage_caller_assigned_to_job(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.jobs
    where id::text = split_part(p_name, '/', 1)
      and auth.uid() = any(assigned_crew)
      and public.same_org(auth.uid(), organization_id)
  );
$function$


CREATE OR REPLACE FUNCTION public.storage_caller_owns_job(p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.jobs
    where id::text = split_part(p_name, '/', 1)
      and customer_id in (select customer_id from public.profiles where id = auth.uid())
      and public.same_org(auth.uid(), organization_id)
  );
$function$


CREATE OR REPLACE FUNCTION public.storage_install_org(p_name text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select organization_id
  from public.installs
  where split_part(p_name, '/', 1) = 'installs'
    and id::text = split_part(p_name, '/', 2);
$function$


CREATE OR REPLACE FUNCTION public.storage_job_org(p_name text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select organization_id from public.jobs where id::text = split_part(p_name, '/', 1);
$function$


CREATE OR REPLACE FUNCTION public.storage_object_added()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org  uuid;
  v_size bigint;
begin
  v_org := public.storage_object_org(new.name, new.bucket_id);
  if v_org is null then
    return new;
  end if;
  v_size := coalesce((new.metadata ->> 'size')::bigint, 0);
  if v_size <= 0 then
    return new;
  end if;
  update public.organizations
    set storage_bytes = storage_bytes + v_size
    where id = v_org;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.storage_object_org(p_name text, p_bucket text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
begin
  if p_bucket in ('job-photos', 'blueprints', 'receipts', 'submittal-files') then
    return public.storage_job_org(p_name);
  elsif p_bucket = 'subcontractor-files' then
    return public.storage_sub_org(p_name);
  elsif p_bucket in ('org-logos', 'proposal-docs') then
    select id into v_org from public.organizations
      where id::text = split_part(p_name, '/', 1);
    return v_org;
  else
    return null;
  end if;
end;
$function$


CREATE OR REPLACE FUNCTION public.storage_object_removed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org  uuid;
  v_size bigint;
begin
  v_org := public.storage_object_org(old.name, old.bucket_id);
  if v_org is null then
    return old;
  end if;
  v_size := coalesce((old.metadata ->> 'size')::bigint, 0);
  if v_size <= 0 then
    return old;
  end if;
  update public.organizations
    set storage_bytes = greatest(0, storage_bytes - v_size)
    where id = v_org;
  return old;
end;
$function$


CREATE OR REPLACE FUNCTION public.storage_sub_org(p_name text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select organization_id from public.subcontractors where id::text = split_part(p_name, '/', 1);
$function$


CREATE OR REPLACE FUNCTION public.sync_crew_member_from_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(new.role, '') in ('crew', 'superintendent') then
    insert into public.crew_members (id, organization_id, name, user_id)
    values (new.id, new.organization_id,
            coalesce(nullif(trim(new.full_name), ''), 'Crew'),
            new.id)
    on conflict (organization_id, user_id) do update
      set name   = excluded.name,
          organization_id = excluded.organization_id;
  end if;
  return new;
end;
$function$


CREATE OR REPLACE FUNCTION public.sync_install_open_problem()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_install uuid := coalesce(new.install_id, old.install_id);
begin
  update public.installs i
     set has_open_problem = exists (
           select 1 from public.install_issues x
           where x.install_id = v_install and x.status = 'open')
   where i.id = v_install;
  return null;
end;
$function$


CREATE OR REPLACE FUNCTION public.tier_accountant(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (public.is_accountant(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$function$


CREATE OR REPLACE FUNCTION public.tier_management(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (public.is_management(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$function$


CREATE OR REPLACE FUNCTION public.tier_office(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (public.is_office(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$function$


CREATE OR REPLACE FUNCTION public.tier_office_or_pm(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (public.is_office_or_pm(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$function$


CREATE OR REPLACE FUNCTION public.tier_pipeline(org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (public.is_pipeline(auth.uid()) or public.is_super_admin(auth.uid()))
      and public.same_org(auth.uid(), org_id);
$function$


CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$


-- ======================================================= RLS POLICIES (public) ======================================================
CREATE POLICY "office delete accounting connections" ON public.accounting_connections FOR DELETE TO authenticated USING (tier_office(organization_id));
CREATE POLICY "office read accounting connections" ON public.accounting_connections FOR SELECT TO authenticated USING (tier_office(organization_id));
CREATE POLICY "office update accounting connections" ON public.accounting_connections FOR UPDATE TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY ai_action_log_read_own ON public.ai_action_log FOR SELECT TO public USING (same_org(auth.uid(), organization_id));
CREATE POLICY "Super admin read billing events" ON public.billing_events FOR SELECT TO authenticated USING (is_super_admin(auth.uid()));
CREATE POLICY "Crew blueprints select" ON public.blueprints FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = blueprints.job_id) AND (auth.uid() = ANY (jobs.assigned_crew)))))));
CREATE POLICY "Crew view assigned blueprints" ON public.blueprints FOR SELECT TO public USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (auth.uid() = ANY (jobs.assigned_crew)))));
CREATE POLICY "Customer blueprints select" ON public.blueprints FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (job_id IN ( SELECT j.id
   FROM jobs j
  WHERE (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid())))))));
CREATE POLICY "Customer view own blueprints" ON public.blueprints FOR SELECT TO public USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (jobs.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))));
CREATE POLICY "Office blueprints all" ON public.blueprints FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "User manage own feed" ON public.calendar_feeds FOR ALL TO authenticated USING ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid())));
CREATE POLICY "Management read change order lines" ON public.change_order_lines FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage change order lines" ON public.change_order_lines FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Accountant read change_orders" ON public.change_orders FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY "Customer read own change orders" ON public.change_orders FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (status = ANY (ARRAY['sent'::text, 'approved'::text, 'rejected'::text])) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = change_orders.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read change orders" ON public.change_orders FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage change orders" ON public.change_orders FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY chem_app_crew_insert_own ON public.chemical_applications FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (applicator_id = auth.uid())));
CREATE POLICY chem_app_crew_read_own ON public.chemical_applications FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND ((applicator_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM lawn_visits lv
  WHERE ((lv.id = chemical_applications.visit_id) AND (lv.crew_id = auth.uid())))))));
CREATE POLICY chem_app_management_read ON public.chemical_applications FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY chem_app_office_all ON public.chemical_applications FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY chem_product_office_all ON public.chemical_products FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY chem_product_same_org_read ON public.chemical_products FOR SELECT TO authenticated USING (same_org(auth.uid(), organization_id));
CREATE POLICY "office cost_codes_all" ON public.cost_codes FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "read cost_codes" ON public.cost_codes FOR SELECT TO authenticated USING (same_org(auth.uid(), organization_id));
CREATE POLICY "office delete crew members" ON public.crew_members FOR DELETE TO authenticated USING (tier_office(organization_id));
CREATE POLICY "office insert crew members" ON public.crew_members FOR INSERT TO authenticated WITH CHECK (tier_office(organization_id));
CREATE POLICY "office update crew members" ON public.crew_members FOR UPDATE TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "same org read crew members" ON public.crew_members FOR SELECT TO authenticated USING (same_org(auth.uid(), organization_id));
CREATE POLICY "Accountant read customers" ON public.customers FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY "Customer see own record" ON public.customers FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))));
CREATE POLICY "Management read customers" ON public.customers FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office all customers" ON public.customers FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "Crew insert daily logs" ON public.daily_logs FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = daily_logs.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Crew read assigned daily logs" ON public.daily_logs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = daily_logs.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Crew update own daily logs" ON public.daily_logs FOR UPDATE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (created_by = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (created_by = auth.uid())));
CREATE POLICY "Field mgmt review daily logs" ON public.daily_logs FOR UPDATE TO authenticated USING (tier_management(organization_id)) WITH CHECK (tier_management(organization_id));
CREATE POLICY "Management read daily logs" ON public.daily_logs FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage daily logs" ON public.daily_logs FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY crew_estimate_items_select ON public.estimate_line_items FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM (estimates e
     JOIN jobs j ON ((j.id = e.job_id)))
  WHERE ((e.id = estimate_line_items.estimate_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY customer_estimate_items_select ON public.estimate_line_items FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM estimates e
  WHERE ((e.id = estimate_line_items.estimate_id) AND (e.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))) AND (e.status = ANY (ARRAY['sent'::text, 'approved'::text, 'rejected'::text])))))));
CREATE POLICY office_estimate_items_all ON public.estimate_line_items FOR ALL TO authenticated USING (tier_pipeline(organization_id)) WITH CHECK (tier_pipeline(organization_id));
CREATE POLICY office_template_items_all ON public.estimate_template_items FOR ALL TO authenticated USING (same_org(auth.uid(), organization_id)) WITH CHECK (same_org(auth.uid(), organization_id));
CREATE POLICY office_templates_all ON public.estimate_templates FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY crew_estimates_select ON public.estimates FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = estimates.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY customer_estimates_select ON public.estimates FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (status = ANY (ARRAY['sent'::text, 'approved'::text, 'rejected'::text]))));
CREATE POLICY office_estimates_all ON public.estimates FOR ALL TO authenticated USING (tier_pipeline(organization_id)) WITH CHECK (tier_pipeline(organization_id));
CREATE POLICY crew_read_assigned_install_issues ON public.install_issues FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM installs i
  WHERE ((i.id = install_issues.install_id) AND (auth.uid() = ANY (i.assigned_crew)))))));
CREATE POLICY management_read_install_issues ON public.install_issues FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY office_manage_install_issues ON public.install_issues FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY crew_read_assigned_install_materials ON public.install_materials FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM installs i
  WHERE ((i.id = install_materials.install_id) AND (auth.uid() = ANY (i.assigned_crew)))))));
CREATE POLICY management_read_install_materials ON public.install_materials FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY office_manage_install_materials ON public.install_materials FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY crew_read_assigned_install_notes ON public.install_notes FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM installs i
  WHERE ((i.id = install_notes.install_id) AND (auth.uid() = ANY (i.assigned_crew)))))));
CREATE POLICY management_read_install_notes ON public.install_notes FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY office_manage_install_notes ON public.install_notes FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY crew_read_own_install_time ON public.install_time_entries FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid())));
CREATE POLICY management_read_install_time ON public.install_time_entries FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY office_manage_install_time ON public.install_time_entries FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY office_manage_install_types ON public.install_types FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY same_org_read_install_types ON public.install_types FOR SELECT TO authenticated USING (same_org(auth.uid(), organization_id));
CREATE POLICY crew_read_assigned_installs ON public.installs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (auth.uid() = ANY (assigned_crew))));
CREATE POLICY customer_read_own_installs ON public.installs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))));
CREATE POLICY management_read_installs ON public.installs FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY office_manage_installs ON public.installs FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Accountant read invoice_line_items" ON public.invoice_line_items FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY customer_invoice_line_items_select ON public.invoice_line_items FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = invoice_line_items.invoice_id) AND (i.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY office_invoice_line_items_all ON public.invoice_line_items FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Accountant read invoices" ON public.invoices FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY customer_invoices_select ON public.invoices FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))));
CREATE POLICY office_invoices_all ON public.invoices FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Crew read assigned job inspections" ON public.job_inspections FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = job_inspections.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Customer read own job inspections" ON public.job_inspections FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = job_inspections.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read job inspections" ON public.job_inspections FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage job inspections" ON public.job_inspections FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Management read job_subcontractors" ON public.job_subcontractors FOR SELECT TO authenticated USING ((is_management(auth.uid()) AND (NOT is_office_or_pm(auth.uid())) AND same_org(auth.uid(), organization_id)));
CREATE POLICY "Office all job_subcontractors" ON public.job_subcontractors FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Crew read assigned job tasks" ON public.job_tasks FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = job_tasks.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Customer read own job tasks" ON public.job_tasks FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = job_tasks.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read job tasks" ON public.job_tasks FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage job tasks" ON public.job_tasks FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Users manage own views" ON public.job_views FOR ALL TO authenticated USING ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid())));
CREATE POLICY office_delete_job_views ON public.job_views FOR DELETE TO authenticated USING (tier_office(organization_id));
CREATE POLICY "Accountant read jobs" ON public.jobs FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY "Crew read jobs via lawn visit" ON public.jobs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND lawn_visit_assigned_to(id, auth.uid())));
CREATE POLICY "Crew see assigned jobs" ON public.jobs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (auth.uid() = ANY (assigned_crew))));
CREATE POLICY "Crew view assigned jobs" ON public.jobs FOR SELECT TO public USING ((auth.uid() = ANY (assigned_crew)));
CREATE POLICY "Customer see own jobs" ON public.jobs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))));
CREATE POLICY "Management see jobs" ON public.jobs FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office insert jobs" ON public.jobs FOR INSERT TO authenticated WITH CHECK (tier_office(organization_id));
CREATE POLICY "Office select jobs" ON public.jobs FOR SELECT TO authenticated USING (tier_office(organization_id));
CREATE POLICY "Office update jobs" ON public.jobs FOR UPDATE TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY office_delete_jobs ON public.jobs FOR DELETE TO authenticated USING (tier_office(organization_id));
CREATE POLICY "Crew read assigned lawn job profiles" ON public.lawn_jobs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = lawn_jobs.id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Crew read lawn_jobs via visit" ON public.lawn_jobs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM lawn_visits lv
  WHERE ((lv.job_id = lawn_jobs.id) AND (lv.crew_id = auth.uid()))))));
CREATE POLICY "Customer read own lawn job profile" ON public.lawn_jobs FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = lawn_jobs.id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read lawn job profiles" ON public.lawn_jobs FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage lawn job profiles" ON public.lawn_jobs FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Management read lawn services" ON public.lawn_services FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage lawn services" ON public.lawn_services FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "Crew read assigned lawn visits" ON public.lawn_visits FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = lawn_visits.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Crew read my route lawn visits" ON public.lawn_visits FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (crew_id = auth.uid())));
CREATE POLICY "Crew update my route lawn visits" ON public.lawn_visits FOR UPDATE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (crew_id = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (crew_id = auth.uid())));
CREATE POLICY "Customer read own lawn visits" ON public.lawn_visits FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = lawn_visits.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read lawn visits" ON public.lawn_visits FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage lawn visits" ON public.lawn_visits FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY lead_management_read ON public.leads FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY lead_office_all ON public.leads FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "office insert notification log" ON public.notification_log FOR INSERT TO authenticated WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "office read notification log" ON public.notification_log FOR SELECT TO authenticated USING (tier_office(organization_id));
CREATE POLICY "office manage notification settings" ON public.notification_settings FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "office manage notification templates" ON public.notification_templates FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "office mark notifications read" ON public.notifications FOR UPDATE TO public USING (tier_office(organization_id));
CREATE POLICY "office read notifications" ON public.notifications FOR SELECT TO public USING (tier_office(organization_id));
CREATE POLICY "Org admin update org" ON public.organizations FOR UPDATE TO authenticated USING ((same_org(auth.uid(), id) AND (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))))) WITH CHECK ((same_org(auth.uid(), id) AND (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))));
CREATE POLICY "Org members read org" ON public.organizations FOR SELECT TO authenticated USING (same_org(auth.uid(), id));
CREATE POLICY accountant_payments_select ON public.payments FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY customer_payments_select ON public.payments FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM invoices i
  WHERE ((i.id = payments.invoice_id) AND (i.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY office_payments_all ON public.payments FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Crew insert install photos" ON public.photos FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM installs i
  WHERE ((i.id = photos.install_id) AND (auth.uid() = ANY (i.assigned_crew)))))));
CREATE POLICY "Crew insert lawn-visit photos" ON public.photos FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (visit_id IN ( SELECT lawn_visits.id
   FROM lawn_visits
  WHERE (lawn_visits.crew_id = auth.uid())))));
CREATE POLICY "Crew insert photos" ON public.photos FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = photos.job_id) AND (auth.uid() = ANY (jobs.assigned_crew)))))));
CREATE POLICY "Crew photos assigned" ON public.photos FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = photos.job_id) AND (auth.uid() = ANY (jobs.assigned_crew)))))));
CREATE POLICY "Crew read install photos" ON public.photos FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM installs i
  WHERE ((i.id = photos.install_id) AND (auth.uid() = ANY (i.assigned_crew)))))));
CREATE POLICY "Crew read lawn-visit photos rows" ON public.photos FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (visit_id IN ( SELECT lawn_visits.id
   FROM lawn_visits
  WHERE (lawn_visits.crew_id = auth.uid())))));
CREATE POLICY "Crew update own photos" ON public.photos FOR UPDATE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (uploaded_by = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (uploaded_by = auth.uid())));
CREATE POLICY "Crew view own photos" ON public.photos FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = photos.job_id) AND (auth.uid() = ANY (jobs.assigned_crew))))));
CREATE POLICY "Customer see own photos" ON public.photos FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (job_id IN ( SELECT j.id
   FROM jobs j
  WHERE (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid())))))));
CREATE POLICY "Office insert photos" ON public.photos FOR INSERT TO authenticated WITH CHECK (tier_office(organization_id));
CREATE POLICY "Office photos select" ON public.photos FOR SELECT TO authenticated USING (tier_office(organization_id));
CREATE POLICY "Office update photos" ON public.photos FOR UPDATE TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY office_delete_photos ON public.photos FOR DELETE TO authenticated USING (tier_office(organization_id));
CREATE POLICY "Customer read own portal approvals" ON public.portal_approvals FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))));
CREATE POLICY "Office read portal approvals" ON public.portal_approvals FOR SELECT TO authenticated USING (tier_office_or_pm(organization_id));
CREATE POLICY "Customer insert own portal messages" ON public.portal_messages FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (sender = 'client'::text)));
CREATE POLICY "Customer read own portal messages" ON public.portal_messages FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (customer_id IN ( SELECT profiles.customer_id
   FROM profiles
  WHERE (profiles.id = auth.uid())))));
CREATE POLICY "Office manage portal messages" ON public.portal_messages FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK ((tier_office_or_pm(organization_id) AND (sender = 'office'::text)));
CREATE POLICY "Management read field-team profiles" ON public.profiles FOR SELECT TO authenticated USING ((tier_management(organization_id) AND (role = ANY (ARRAY['crew'::text, 'superintendent'::text, 'project_manager'::text]))));
CREATE POLICY "Office edit customer_id on profiles" ON public.profiles FOR UPDATE TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "Office insert profiles" ON public.profiles FOR INSERT TO authenticated WITH CHECK (tier_office(organization_id));
CREATE POLICY "Office read all profiles" ON public.profiles FOR SELECT TO authenticated USING (tier_office(organization_id));
CREATE POLICY "Users read own profile" ON public.profiles FOR SELECT TO authenticated USING ((id = auth.uid()));
CREATE POLICY "Crew insert punch items" ON public.punch_items FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = punch_items.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Crew read assigned punch items" ON public.punch_items FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND ((assigned_to = auth.uid()) OR (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = punch_items.job_id) AND (auth.uid() = ANY (j.assigned_crew))))))));
CREATE POLICY "Crew update assigned punch items" ON public.punch_items FOR UPDATE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (assigned_to = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (assigned_to = auth.uid())));
CREATE POLICY "Customer read own punch items" ON public.punch_items FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = punch_items.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Field mgmt manage punch items" ON public.punch_items FOR ALL TO authenticated USING (tier_management(organization_id)) WITH CHECK (tier_management(organization_id));
CREATE POLICY "Management read punch items" ON public.punch_items FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Accountant read receipts" ON public.receipts FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY crew_receipts_delete_own ON public.receipts FOR DELETE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (uploaded_by = auth.uid())));
CREATE POLICY crew_receipts_insert ON public.receipts FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = receipts.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY crew_receipts_select ON public.receipts FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = receipts.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY office_receipts_all ON public.receipts FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY "Crew read assigned recurring schedules" ON public.recurring_schedules FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = recurring_schedules.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Customer read own recurring schedules" ON public.recurring_schedules FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = recurring_schedules.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read recurring schedules" ON public.recurring_schedules FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage recurring schedules" ON public.recurring_schedules FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY review_management_read ON public.review_requests FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY review_office_all ON public.review_requests FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Crew insert rfis" ON public.rfis FOR INSERT TO public WITH CHECK ((EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = rfis.job_id) AND (auth.uid() = ANY (jobs.assigned_crew))))));
CREATE POLICY "Crew view assigned job rfis" ON public.rfis FOR SELECT TO public USING ((job_id IN ( SELECT jobs.id
   FROM jobs
  WHERE (auth.uid() = ANY (jobs.assigned_crew)))));
CREATE POLICY "Crew view own rfis" ON public.rfis FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM jobs
  WHERE ((jobs.id = rfis.job_id) AND (auth.uid() = ANY (jobs.assigned_crew))))));
CREATE POLICY "Office rfis all" ON public.rfis FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));
CREATE POLICY route_opt_log_read_own ON public.route_optimizations_log FOR SELECT TO public USING (same_org(auth.uid(), organization_id));
CREATE POLICY "Crew read assigned schedule events" ON public.schedule_events FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = schedule_events.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Customer read own schedule events" ON public.schedule_events FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = schedule_events.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read schedule events" ON public.schedule_events FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage schedule events" ON public.schedule_events FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Management read sub attachments" ON public.subcontractor_attachments FOR SELECT TO authenticated USING ((is_management(auth.uid()) AND (NOT is_office_or_pm(auth.uid())) AND same_org(auth.uid(), organization_id)));
CREATE POLICY "Office all sub attachments" ON public.subcontractor_attachments FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Accountant read subcontractors" ON public.subcontractors FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY "Management read subcontractors" ON public.subcontractors FOR SELECT TO authenticated USING ((is_management(auth.uid()) AND (NOT is_office_or_pm(auth.uid())) AND same_org(auth.uid(), organization_id)));
CREATE POLICY "Office all subcontractors" ON public.subcontractors FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Crew read assigned submittal files" ON public.submittal_files FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = submittal_files.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Customer read own submittal files" ON public.submittal_files FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = submittal_files.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read submittal files" ON public.submittal_files FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage submittal files" ON public.submittal_files FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Crew read assigned submittals" ON public.submittals FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = submittals.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "Customer read own submittals" ON public.submittals FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = submittals.job_id) AND (j.customer_id IN ( SELECT profiles.customer_id
           FROM profiles
          WHERE (profiles.id = auth.uid()))))))));
CREATE POLICY "Management read submittals" ON public.submittals FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Office manage submittals" ON public.submittals FOR ALL TO authenticated USING (tier_office_or_pm(organization_id)) WITH CHECK (tier_office_or_pm(organization_id));
CREATE POLICY "Accountant read time_entries" ON public.time_entries FOR SELECT TO authenticated USING (tier_accountant(organization_id));
CREATE POLICY "Field mgmt read time" ON public.time_entries FOR SELECT TO authenticated USING (tier_management(organization_id));
CREATE POLICY "Field mgmt review time" ON public.time_entries FOR UPDATE TO authenticated USING (tier_management(organization_id)) WITH CHECK (tier_management(organization_id));
CREATE POLICY "crew time_delete_own" ON public.time_entries FOR DELETE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid())));
CREATE POLICY "crew time_insert_own" ON public.time_entries FOR INSERT TO authenticated WITH CHECK ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM jobs j
  WHERE ((j.id = time_entries.job_id) AND (auth.uid() = ANY (j.assigned_crew)))))));
CREATE POLICY "crew time_select_own" ON public.time_entries FOR SELECT TO authenticated USING ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid())));
CREATE POLICY "crew time_update_own" ON public.time_entries FOR UPDATE TO authenticated USING ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid()))) WITH CHECK ((same_org(auth.uid(), organization_id) AND (user_id = auth.uid())));
CREATE POLICY "office time_all" ON public.time_entries FOR ALL TO authenticated USING (tier_office(organization_id)) WITH CHECK (tier_office(organization_id));

-- ============================================================= TRIGGERS ============================================================
CREATE TRIGGER trg_accounting_connections_touch BEFORE UPDATE ON public.accounting_connections FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
CREATE TRIGGER trg_blueprints_org BEFORE INSERT ON public.blueprints FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_change_order_lines_org BEFORE INSERT ON public.change_order_lines FOR EACH ROW EXECUTE FUNCTION set_org_from_change_order()
CREATE TRIGGER trg_change_orders_org BEFORE INSERT ON public.change_orders FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_chem_app_org BEFORE INSERT ON public.chemical_applications FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_crew_members_org BEFORE INSERT ON public.crew_members FOR EACH ROW EXECUTE FUNCTION set_org_from_crew_member()
CREATE TRIGGER trg_crew_members_touch BEFORE UPDATE ON public.crew_members FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
CREATE TRIGGER trg_guard_crew_member_create BEFORE INSERT ON public.crew_members FOR EACH ROW EXECUTE FUNCTION guard_crew_member_create()
CREATE TRIGGER trg_guard_customer_create BEFORE INSERT ON public.customers FOR EACH ROW EXECUTE FUNCTION guard_customer_create()
CREATE TRIGGER trg_daily_logs_org BEFORE INSERT ON public.daily_logs FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_estimate_line_items_org BEFORE INSERT ON public.estimate_line_items FOR EACH ROW EXECUTE FUNCTION set_org_from_estimate()
CREATE TRIGGER trg_estimate_template_items_org BEFORE INSERT ON public.estimate_template_items FOR EACH ROW EXECUTE FUNCTION set_org_from_template()
CREATE TRIGGER trg_estimates_org BEFORE INSERT ON public.estimates FOR EACH ROW EXECUTE FUNCTION set_org_from_job_or_org()
CREATE TRIGGER trg_sync_install_open_problem AFTER INSERT OR DELETE OR UPDATE ON public.install_issues FOR EACH ROW EXECUTE FUNCTION sync_install_open_problem()
CREATE TRIGGER trg_set_org_from_install BEFORE INSERT ON public.installs FOR EACH ROW EXECUTE FUNCTION set_org_from_job_or_org()
CREATE TRIGGER trg_touch_installs BEFORE UPDATE ON public.installs FOR EACH ROW EXECUTE FUNCTION touch_updated_at()
CREATE TRIGGER trg_invoice_line_items_org BEFORE INSERT ON public.invoice_line_items FOR EACH ROW EXECUTE FUNCTION set_org_from_invoice()
CREATE TRIGGER trg_invoices_org BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION set_org_from_job_or_estimate()
CREATE TRIGGER trg_job_inspections_org BEFORE INSERT ON public.job_inspections FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_job_subcontractors_org BEFORE INSERT ON public.job_subcontractors FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_job_tasks_org BEFORE INSERT ON public.job_tasks FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_job_views_org BEFORE INSERT OR UPDATE ON public.job_views FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_guard_job_create BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION guard_job_create()
CREATE TRIGGER trg_jobs_variant_guard BEFORE INSERT OR UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION guard_jobs_variant()
CREATE TRIGGER trg_lawn_visit_crew_guard BEFORE UPDATE ON public.lawn_visits FOR EACH ROW EXECUTE FUNCTION guard_lawn_visit_crew_update()
CREATE TRIGGER trg_lawn_visits_org BEFORE INSERT ON public.lawn_visits FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_seed_notification_templates AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION seed_notification_templates()
CREATE TRIGGER trg_photos_org BEFORE INSERT ON public.photos FOR EACH ROW EXECUTE FUNCTION set_org_from_photo_parent()
CREATE TRIGGER trg_portal_messages_org BEFORE INSERT ON public.portal_messages FOR EACH ROW EXECUTE FUNCTION set_org_from_customer()
CREATE TRIGGER trg_guard_profile_create BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_create()
CREATE TRIGGER trg_sync_crew_member_on_profile AFTER INSERT OR UPDATE OF role, full_name, organization_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION sync_crew_member_from_profile()
CREATE TRIGGER trg_punch_items_org BEFORE INSERT ON public.punch_items FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_receipts_org BEFORE INSERT ON public.receipts FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_recurring_schedules_org BEFORE INSERT ON public.recurring_schedules FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_rfis_org BEFORE INSERT ON public.rfis FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_schedule_events_org BEFORE INSERT ON public.schedule_events FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_subcontractor_attachments_org BEFORE INSERT ON public.subcontractor_attachments FOR EACH ROW EXECUTE FUNCTION set_org_from_subcontractor()
CREATE TRIGGER trg_submittal_files_org BEFORE INSERT ON public.submittal_files FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_submittals_org BEFORE INSERT ON public.submittals FOR EACH ROW EXECUTE FUNCTION set_org_from_job()
CREATE TRIGGER trg_time_entries_org BEFORE INSERT ON public.time_entries FOR EACH ROW EXECUTE FUNCTION set_org_from_job()

-- ======================================================== STORAGE BUCKETS ==========================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('blueprints', 'blueprints', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('job-photos', 'job-photos', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('org-logos', 'org-logos', true);
INSERT INTO storage.buckets (id, name, public) VALUES ('proposal-docs', 'proposal-docs', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('receipts', 'receipts', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('subcontractor-files', 'subcontractor-files', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('submittal-files', 'submittal-files', false);

-- ======================================================= STORAGE POLICIES ==========================================================
CREATE POLICY "Authenticated read blueprints" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'blueprints'::text) AND (tier_office(storage_job_org(name)) OR storage_caller_assigned_to_job(name) OR storage_caller_owns_job(name))));
CREATE POLICY "Authenticated read job-photos" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'job-photos'::text) AND (tier_office(storage_job_org(name)) OR storage_caller_assigned_to_job(name) OR storage_caller_owns_job(name))));
CREATE POLICY "Authenticated read submittal files" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'submittal-files'::text) AND (tier_office(storage_job_org(name)) OR storage_caller_assigned_to_job(name) OR storage_caller_owns_job(name))));
CREATE POLICY "Crew delete receipts storage" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'receipts'::text) AND storage_caller_assigned_to_job(name)));
CREATE POLICY "Crew read lawn-visit photos" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'job-photos'::text) AND (EXISTS ( SELECT 1
   FROM lawn_visits lv
  WHERE (((lv.id)::text = split_part(objects.name, '/'::text, 2)) AND (lv.crew_id = auth.uid()))))));
CREATE POLICY "Crew read receipts storage" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'receipts'::text) AND (tier_office(storage_job_org(name)) OR storage_caller_assigned_to_job(name))));
CREATE POLICY "Crew upload install photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'job-photos'::text) AND storage_caller_assigned_to_install(name)));
CREATE POLICY "Crew upload lawn-visit photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'job-photos'::text) AND (EXISTS ( SELECT 1
   FROM lawn_visits lv
  WHERE (((lv.id)::text = split_part(objects.name, '/'::text, 2)) AND (lv.crew_id = auth.uid()))))));
CREATE POLICY "Crew upload photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'job-photos'::text) AND storage_caller_assigned_to_job(name)));
CREATE POLICY "Crew upload receipts storage" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'receipts'::text) AND storage_caller_assigned_to_job(name)));
CREATE POLICY "Management read subcontractor-files storage" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'subcontractor-files'::text) AND is_management(auth.uid()) AND (NOT is_office_or_pm(auth.uid())) AND (NOT is_super_admin(auth.uid())) AND same_org(auth.uid(), storage_sub_org(name))));
CREATE POLICY "Office all receipts storage" ON storage.objects FOR ALL TO authenticated USING (((bucket_id = 'receipts'::text) AND tier_office(storage_job_org(name)))) WITH CHECK (((bucket_id = 'receipts'::text) AND tier_office(storage_job_org(name))));
CREATE POLICY "Office all subcontractor-files storage" ON storage.objects FOR ALL TO authenticated USING (((bucket_id = 'subcontractor-files'::text) AND tier_office_or_pm(storage_sub_org(name)))) WITH CHECK (((bucket_id = 'subcontractor-files'::text) AND tier_office_or_pm(storage_sub_org(name))));
CREATE POLICY "Office delete blueprints" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'blueprints'::text) AND tier_office_or_pm(storage_job_org(name))));
CREATE POLICY "Office delete install photos" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'job-photos'::text) AND tier_office(storage_install_org(name))));
CREATE POLICY "Office delete submittal files" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'submittal-files'::text) AND tier_office(storage_job_org(name))));
CREATE POLICY "Office upload blueprints" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'blueprints'::text) AND tier_office_or_pm(storage_job_org(name))));
CREATE POLICY "Office upload install photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'job-photos'::text) AND tier_office(storage_install_org(name))));
CREATE POLICY "Office upload photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'job-photos'::text) AND tier_office(storage_job_org(name))));
CREATE POLICY "Office upload submittal files" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'submittal-files'::text) AND tier_office(storage_job_org(name))));
CREATE POLICY "Org logo delete" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'org-logos'::text) AND (is_super_admin(auth.uid()) OR (is_office(auth.uid()) AND (name ~~ (my_org_id(auth.uid()) || '/%'::text))))));
CREATE POLICY "Org logo insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'org-logos'::text) AND (is_super_admin(auth.uid()) OR (is_office(auth.uid()) AND (name ~~ (my_org_id(auth.uid()) || '/%'::text))))));
CREATE POLICY "Org logo read" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'org-logos'::text) AND (is_super_admin(auth.uid()) OR (name ~~ (my_org_id(auth.uid()) || '/%'::text)))));
CREATE POLICY "Org logo update" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'org-logos'::text) AND (is_super_admin(auth.uid()) OR (is_office(auth.uid()) AND (name ~~ (my_org_id(auth.uid()) || '/%'::text)))))) WITH CHECK (((bucket_id = 'org-logos'::text) AND (is_super_admin(auth.uid()) OR (is_office(auth.uid()) AND (name ~~ (my_org_id(auth.uid()) || '/%'::text))))));
CREATE POLICY "Read install photos" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'job-photos'::text) AND (tier_office(storage_install_org(name)) OR storage_caller_assigned_to_install(name))));
CREATE POLICY office_delete_job_photos ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'job-photos'::text) AND tier_office(storage_job_org(name))));