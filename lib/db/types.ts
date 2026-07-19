export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ai_plan_applications: {
        Row: {
          applied_by: string | null
          applied_count: number
          created_at: string
          failed_count: number
          id: string
          mutations: Json
          plan_id: string
          results: Json | null
          summary: string | null
        }
        Insert: {
          applied_by?: string | null
          applied_count?: number
          created_at?: string
          failed_count?: number
          id?: string
          mutations: Json
          plan_id: string
          results?: Json | null
          summary?: string | null
        }
        Update: {
          applied_by?: string | null
          applied_count?: number
          created_at?: string
          failed_count?: number
          id?: string
          mutations?: Json
          plan_id?: string
          results?: Json | null
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_plan_applications_applied_by_fkey"
            columns: ["applied_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          key: string
          org_id: string
          updated_at: string
          updated_by: string | null
          value: string | null
        }
        Insert: {
          key: string
          org_id?: string
          updated_at?: string
          updated_by?: string | null
          value?: string | null
        }
        Update: {
          key?: string
          org_id?: string
          updated_at?: string
          updated_by?: string | null
          value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_comments: {
        Row: {
          author_name: string
          author_profile_id: string | null
          bid_recipient_id: string
          body: string
          created_at: string
          id: string
        }
        Insert: {
          author_name: string
          author_profile_id?: string | null
          bid_recipient_id: string
          body: string
          created_at?: string
          id?: string
        }
        Update: {
          author_name?: string
          author_profile_id?: string | null
          bid_recipient_id?: string
          body?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bid_comments_author_profile_id_fkey"
            columns: ["author_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bid_comments_bid_recipient_id_fkey"
            columns: ["bid_recipient_id"]
            isOneToOne: false
            referencedRelation: "bid_recipients"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_line_item_quotes: {
        Row: {
          bid_recipient_id: string
          created_at: string
          id: string
          line_item_id: string
          unit_cost: number
          updated_at: string
        }
        Insert: {
          bid_recipient_id: string
          created_at?: string
          id?: string
          line_item_id: string
          unit_cost?: number
          updated_at?: string
        }
        Update: {
          bid_recipient_id?: string
          created_at?: string
          id?: string
          line_item_id?: string
          unit_cost?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bid_line_item_quotes_bid_recipient_id_fkey"
            columns: ["bid_recipient_id"]
            isOneToOne: false
            referencedRelation: "bid_recipients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bid_line_item_quotes_line_item_id_fkey"
            columns: ["line_item_id"]
            isOneToOne: false
            referencedRelation: "bid_package_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_package_attachments: {
        Row: {
          bid_package_id: string
          caption: string | null
          created_at: string
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          position: number
          project_file_id: string | null
          storage_bucket: string
          storage_path: string
        }
        Insert: {
          bid_package_id: string
          caption?: string | null
          created_at?: string
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          project_file_id?: string | null
          storage_bucket?: string
          storage_path: string
        }
        Update: {
          bid_package_id?: string
          caption?: string | null
          created_at?: string
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          project_file_id?: string | null
          storage_bucket?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "bid_package_attachments_bid_package_id_fkey"
            columns: ["bid_package_id"]
            isOneToOne: false
            referencedRelation: "bid_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bid_package_attachments_project_file_id_fkey"
            columns: ["project_file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_package_line_items: {
        Row: {
          bid_package_id: string
          cost_code_id: string | null
          created_at: string
          description: string
          id: string
          position: number
          quantity: number
          unit: string | null
        }
        Insert: {
          bid_package_id: string
          cost_code_id?: string | null
          created_at?: string
          description: string
          id?: string
          position?: number
          quantity?: number
          unit?: string | null
        }
        Update: {
          bid_package_id?: string
          cost_code_id?: string | null
          created_at?: string
          description?: string
          id?: string
          position?: number
          quantity?: number
          unit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bid_package_line_items_bid_package_id_fkey"
            columns: ["bid_package_id"]
            isOneToOne: false
            referencedRelation: "bid_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bid_package_line_items_cost_code_id_fkey"
            columns: ["cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_packages: {
        Row: {
          allow_multiple_awards: boolean
          awarded_at: string | null
          closed_at: string | null
          created_at: string
          created_by: string | null
          due_date: string | null
          flat_fee: boolean
          id: string
          number: number
          project_id: string
          scope: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["bid_package_status"]
          title: string
          updated_at: string
        }
        Insert: {
          allow_multiple_awards?: boolean
          awarded_at?: string | null
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          flat_fee?: boolean
          id?: string
          number: number
          project_id: string
          scope?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["bid_package_status"]
          title: string
          updated_at?: string
        }
        Update: {
          allow_multiple_awards?: boolean
          awarded_at?: string | null
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          flat_fee?: boolean
          id?: string
          number?: number
          project_id?: string
          scope?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["bid_package_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bid_packages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bid_packages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      bid_recipients: {
        Row: {
          awarded_at: string | null
          bid_package_id: string
          company_id: string
          created_at: string
          flat_total: number | null
          id: string
          last_sent_at: string | null
          notes: string | null
          sent_to_email: string | null
          sent_to_phone: string | null
          status: Database["public"]["Enums"]["bid_recipient_status"]
          submitted_at: string | null
          token: string | null
          updated_at: string
          viewed_at: string | null
        }
        Insert: {
          awarded_at?: string | null
          bid_package_id: string
          company_id: string
          created_at?: string
          flat_total?: number | null
          id?: string
          last_sent_at?: string | null
          notes?: string | null
          sent_to_email?: string | null
          sent_to_phone?: string | null
          status?: Database["public"]["Enums"]["bid_recipient_status"]
          submitted_at?: string | null
          token?: string | null
          updated_at?: string
          viewed_at?: string | null
        }
        Update: {
          awarded_at?: string | null
          bid_package_id?: string
          company_id?: string
          created_at?: string
          flat_total?: number | null
          id?: string
          last_sent_at?: string | null
          notes?: string | null
          sent_to_email?: string | null
          sent_to_phone?: string | null
          status?: Database["public"]["Enums"]["bid_recipient_status"]
          submitted_at?: string | null
          token?: string | null
          updated_at?: string
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bid_recipients_bid_package_id_fkey"
            columns: ["bid_package_id"]
            isOneToOne: false
            referencedRelation: "bid_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bid_recipients_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      client_invites: {
        Row: {
          accepted_at: string | null
          accepted_profile_id: string | null
          contact_slot: number | null
          created_at: string
          email: string
          id: string
          invited_at: string
          invited_by: string | null
          name: string | null
          project_id: string
          token: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_profile_id?: string | null
          contact_slot?: number | null
          created_at?: string
          email: string
          id?: string
          invited_at?: string
          invited_by?: string | null
          name?: string | null
          project_id: string
          token?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_profile_id?: string | null
          contact_slot?: number | null
          created_at?: string
          email?: string
          id?: string
          invited_at?: string
          invited_by?: string | null
          name?: string | null
          project_id?: string
          token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_invites_accepted_profile_id_fkey"
            columns: ["accepted_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_invites_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      communications: {
        Row: {
          body: string | null
          call_duration_seconds: number | null
          call_recording_url: string | null
          channel: Database["public"]["Enums"]["comm_channel"]
          company_id: string | null
          counterparty_name: string | null
          created_at: string
          direction: Database["public"]["Enums"]["comm_direction"]
          from_address: string | null
          id: string
          meta: Json
          occurred_at: string
          org_id: string
          profile_id: string | null
          project_id: string | null
          provider_id: string | null
          sent_by: string | null
          source: string
          source_kind: string | null
          status: Database["public"]["Enums"]["comm_status"]
          subject: string | null
          to_address: string | null
        }
        Insert: {
          body?: string | null
          call_duration_seconds?: number | null
          call_recording_url?: string | null
          channel: Database["public"]["Enums"]["comm_channel"]
          company_id?: string | null
          counterparty_name?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["comm_direction"]
          from_address?: string | null
          id?: string
          meta?: Json
          occurred_at?: string
          org_id?: string
          profile_id?: string | null
          project_id?: string | null
          provider_id?: string | null
          sent_by?: string | null
          source: string
          source_kind?: string | null
          status?: Database["public"]["Enums"]["comm_status"]
          subject?: string | null
          to_address?: string | null
        }
        Update: {
          body?: string | null
          call_duration_seconds?: number | null
          call_recording_url?: string | null
          channel?: Database["public"]["Enums"]["comm_channel"]
          company_id?: string | null
          counterparty_name?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["comm_direction"]
          from_address?: string | null
          id?: string
          meta?: Json
          occurred_at?: string
          org_id?: string
          profile_id?: string | null
          project_id?: string | null
          provider_id?: string | null
          sent_by?: string | null
          source?: string
          source_kind?: string | null
          status?: Database["public"]["Enums"]["comm_status"]
          subject?: string | null
          to_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "communications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "communications_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          address: string | null
          aka: string | null
          city: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          insurance_agent_email: string | null
          insurance_agent_name: string | null
          insurance_agent_phone: string | null
          insurance_upload_token: string
          name: string
          notes: string | null
          notifications_enabled: boolean
          org_id: string
          phone: string | null
          phone_secondary: string | null
          postal_code: string | null
          state: string | null
          status: string | null
          trade_category: string | null
          type: Database["public"]["Enums"]["company_type"]
          website: string | null
        }
        Insert: {
          address?: string | null
          aka?: string | null
          city?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          insurance_agent_email?: string | null
          insurance_agent_name?: string | null
          insurance_agent_phone?: string | null
          insurance_upload_token?: string
          name: string
          notes?: string | null
          notifications_enabled?: boolean
          org_id: string
          phone?: string | null
          phone_secondary?: string | null
          postal_code?: string | null
          state?: string | null
          status?: string | null
          trade_category?: string | null
          type: Database["public"]["Enums"]["company_type"]
          website?: string | null
        }
        Update: {
          address?: string | null
          aka?: string | null
          city?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          insurance_agent_email?: string | null
          insurance_agent_name?: string | null
          insurance_agent_phone?: string | null
          insurance_upload_token?: string
          name?: string
          notes?: string | null
          notifications_enabled?: boolean
          org_id?: string
          phone?: string | null
          phone_secondary?: string | null
          postal_code?: string | null
          state?: string | null
          status?: string | null
          trade_category?: string | null
          type?: Database["public"]["Enums"]["company_type"]
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "companies_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      company_trades: {
        Row: {
          company_id: string
          created_at: string
          trade: string
        }
        Insert: {
          company_id: string
          created_at?: string
          trade: string
        }
        Update: {
          company_id?: string
          created_at?: string
          trade?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_trades_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_codes: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          org_id: string
          position: number
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          org_id: string
          position?: number
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          org_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "cost_codes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_log_attachments: {
        Row: {
          caption: string | null
          created_at: string
          daily_log_id: string
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          position: number
          storage_bucket: string
          storage_path: string
          tags: string[]
        }
        Insert: {
          caption?: string | null
          created_at?: string
          daily_log_id: string
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          storage_bucket?: string
          storage_path: string
          tags?: string[]
        }
        Update: {
          caption?: string | null
          created_at?: string
          daily_log_id?: string
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          storage_bucket?: string
          storage_path?: string
          tags?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "daily_log_attachments_daily_log_id_fkey"
            columns: ["daily_log_id"]
            isOneToOne: false
            referencedRelation: "daily_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_log_comments: {
        Row: {
          author_id: string | null
          author_name: string
          body: string
          created_at: string
          daily_log_id: string
          id: string
        }
        Insert: {
          author_id?: string | null
          author_name: string
          body: string
          created_at?: string
          daily_log_id: string
          id?: string
        }
        Update: {
          author_id?: string | null
          author_name?: string
          body?: string
          created_at?: string
          daily_log_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "daily_log_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_log_comments_daily_log_id_fkey"
            columns: ["daily_log_id"]
            isOneToOne: false
            referencedRelation: "daily_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_log_subs_on_site: {
        Row: {
          company_id: string
          daily_log_id: string
          notes: string | null
        }
        Insert: {
          company_id: string
          daily_log_id: string
          notes?: string | null
        }
        Update: {
          company_id?: string
          daily_log_id?: string
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_log_subs_on_site_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_log_subs_on_site_daily_log_id_fkey"
            columns: ["daily_log_id"]
            isOneToOne: false
            referencedRelation: "daily_logs"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_logs: {
        Row: {
          created_at: string
          created_by: string
          hours_worked: number | null
          id: string
          log_date: string
          notes: string | null
          project_id: string
          updated_at: string
          visibility: Database["public"]["Enums"]["daily_log_visibility"]
        }
        Insert: {
          created_at?: string
          created_by: string
          hours_worked?: number | null
          id?: string
          log_date?: string
          notes?: string | null
          project_id: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["daily_log_visibility"]
        }
        Update: {
          created_at?: string
          created_by?: string
          hours_worked?: number | null
          id?: string
          log_date?: string
          notes?: string | null
          project_id?: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["daily_log_visibility"]
        }
        Relationships: [
          {
            foreignKeyName: "daily_logs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_assignments: {
        Row: {
          company_id: string | null
          created_at: string
          decision_id: string
          id: string
          profile_id: string | null
          role_id: string | null
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          decision_id: string
          id?: string
          profile_id?: string | null
          role_id?: string | null
        }
        Update: {
          company_id?: string | null
          created_at?: string
          decision_id?: string
          id?: string
          profile_id?: string | null
          role_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "decision_assignments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_assignments_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_assignments_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_attachments: {
        Row: {
          caption: string | null
          choice_id: string | null
          created_at: string
          decision_id: string
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          position: number
          storage_bucket: string
          storage_path: string
          tags: string[]
        }
        Insert: {
          caption?: string | null
          choice_id?: string | null
          created_at?: string
          decision_id: string
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          storage_bucket?: string
          storage_path: string
          tags?: string[]
        }
        Update: {
          caption?: string | null
          choice_id?: string | null
          created_at?: string
          decision_id?: string
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          storage_bucket?: string
          storage_path?: string
          tags?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "decision_attachments_choice_id_fkey"
            columns: ["choice_id"]
            isOneToOne: false
            referencedRelation: "decision_choices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_attachments_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_choices: {
        Row: {
          created_at: string
          decision_id: string
          description: string | null
          id: string
          position: number
          price_delta: number | null
          title: string
        }
        Insert: {
          created_at?: string
          decision_id: string
          description?: string | null
          id?: string
          position?: number
          price_delta?: number | null
          title: string
        }
        Update: {
          created_at?: string
          decision_id?: string
          description?: string | null
          id?: string
          position?: number
          price_delta?: number | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_choices_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          decision_id: string
          id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          decision_id: string
          id?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          decision_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_comments_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_cost_items: {
        Row: {
          catalog_item_code: string | null
          catalog_item_id: string | null
          choice_id: string | null
          cost_code_id: string | null
          created_at: string
          decision_id: string
          description: string | null
          id: string
          position: number
          quantity: number
          unit: string | null
          unit_cost: number
        }
        Insert: {
          catalog_item_code?: string | null
          catalog_item_id?: string | null
          choice_id?: string | null
          cost_code_id?: string | null
          created_at?: string
          decision_id: string
          description?: string | null
          id?: string
          position?: number
          quantity?: number
          unit?: string | null
          unit_cost?: number
        }
        Update: {
          catalog_item_code?: string | null
          catalog_item_id?: string | null
          choice_id?: string | null
          cost_code_id?: string | null
          created_at?: string
          decision_id?: string
          description?: string | null
          id?: string
          position?: number
          quantity?: number
          unit?: string | null
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "decision_cost_items_choice_matches_decision_fkey"
            columns: ["choice_id", "decision_id"]
            isOneToOne: false
            referencedRelation: "decision_choices"
            referencedColumns: ["id", "decision_id"]
          },
          {
            foreignKeyName: "decision_cost_items_cost_code_id_fkey"
            columns: ["cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_cost_items_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_followup_materializations: {
        Row: {
          created_at: string
          decision_id: string
          schedule_item_id: string | null
          template_id: string
        }
        Insert: {
          created_at?: string
          decision_id: string
          schedule_item_id?: string | null
          template_id: string
        }
        Update: {
          created_at?: string
          decision_id?: string
          schedule_item_id?: string | null
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_followup_materializations_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_followup_materializations_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_followup_materializations_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "decision_followup_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      decision_followup_templates: {
        Row: {
          anchor_schedule_item_id: string | null
          assignee_company_id: string | null
          assignee_profile_id: string | null
          created_at: string
          decision_id: string
          due_offset_days: number
          duration_days: number | null
          id: string
          kind: Database["public"]["Enums"]["schedule_item_kind"]
          notes: string | null
          parent_anchor:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          parent_offset_days: number | null
          position: number
          title: string
        }
        Insert: {
          anchor_schedule_item_id?: string | null
          assignee_company_id?: string | null
          assignee_profile_id?: string | null
          created_at?: string
          decision_id: string
          due_offset_days?: number
          duration_days?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["schedule_item_kind"]
          notes?: string | null
          parent_anchor?:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          parent_offset_days?: number | null
          position?: number
          title: string
        }
        Update: {
          anchor_schedule_item_id?: string | null
          assignee_company_id?: string | null
          assignee_profile_id?: string | null
          created_at?: string
          decision_id?: string
          due_offset_days?: number
          duration_days?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["schedule_item_kind"]
          notes?: string | null
          parent_anchor?:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          parent_offset_days?: number | null
          position?: number
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "decision_followup_templates_anchor_schedule_item_id_fkey"
            columns: ["anchor_schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_followup_templates_assignee_company_id_fkey"
            columns: ["assignee_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_followup_templates_assignee_profile_id_fkey"
            columns: ["assignee_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decision_followup_templates_decision_id_fkey"
            columns: ["decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      decisions: {
        Row: {
          allowance_amount: number | null
          allowance_cost_code_id: string | null
          approved_at: string | null
          approved_by_client_id: string | null
          cost_delta: number | null
          created_at: string
          created_by: string
          delay_cost_per_day: number | null
          delay_days: number | null
          description: string | null
          due_anchor:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          due_anchor_offset_days: number | null
          due_anchor_schedule_item_id: string | null
          due_date: string | null
          id: string
          kind: Database["public"]["Enums"]["decision_kind"]
          markup_percent: number
          number: number
          project_id: string
          selected_choice_id: string | null
          status: Database["public"]["Enums"]["decision_status"]
          template_tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          allowance_amount?: number | null
          allowance_cost_code_id?: string | null
          approved_at?: string | null
          approved_by_client_id?: string | null
          cost_delta?: number | null
          created_at?: string
          created_by: string
          delay_cost_per_day?: number | null
          delay_days?: number | null
          description?: string | null
          due_anchor?:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          due_anchor_offset_days?: number | null
          due_anchor_schedule_item_id?: string | null
          due_date?: string | null
          id?: string
          kind: Database["public"]["Enums"]["decision_kind"]
          markup_percent?: number
          number: number
          project_id: string
          selected_choice_id?: string | null
          status?: Database["public"]["Enums"]["decision_status"]
          template_tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          allowance_amount?: number | null
          allowance_cost_code_id?: string | null
          approved_at?: string | null
          approved_by_client_id?: string | null
          cost_delta?: number | null
          created_at?: string
          created_by?: string
          delay_cost_per_day?: number | null
          delay_days?: number | null
          description?: string | null
          due_anchor?:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          due_anchor_offset_days?: number | null
          due_anchor_schedule_item_id?: string | null
          due_date?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["decision_kind"]
          markup_percent?: number
          number?: number
          project_id?: string
          selected_choice_id?: string | null
          status?: Database["public"]["Enums"]["decision_status"]
          template_tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "decisions_allowance_cost_code_id_fkey"
            columns: ["allowance_cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_approved_by_client_id_fkey"
            columns: ["approved_by_client_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_due_anchor_schedule_item_id_fkey"
            columns: ["due_anchor_schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_selected_choice_id_fkey"
            columns: ["selected_choice_id"]
            isOneToOne: false
            referencedRelation: "decision_choices"
            referencedColumns: ["id"]
          },
        ]
      }
      deleted_items: {
        Row: {
          deleted_at: string
          deleted_by: string | null
          deleted_by_name: string | null
          entity_id: string
          entity_label: string | null
          entity_type: string
          id: string
          payload: Json
          project_id: string
          purge_claimed_at: string | null
          restored_at: string | null
          restored_by: string | null
          storage_paths: string[]
        }
        Insert: {
          deleted_at?: string
          deleted_by?: string | null
          deleted_by_name?: string | null
          entity_id: string
          entity_label?: string | null
          entity_type: string
          id?: string
          payload: Json
          project_id: string
          purge_claimed_at?: string | null
          restored_at?: string | null
          restored_by?: string | null
          storage_paths?: string[]
        }
        Update: {
          deleted_at?: string
          deleted_by?: string | null
          deleted_by_name?: string | null
          entity_id?: string
          entity_label?: string | null
          entity_type?: string
          id?: string
          payload?: Json
          project_id?: string
          purge_claimed_at?: string | null
          restored_at?: string | null
          restored_by?: string | null
          storage_paths?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "deleted_items_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deleted_items_restored_by_fkey"
            columns: ["restored_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_requests: {
        Row: {
          admin_notes: string | null
          created_at: string
          description: string | null
          id: string
          org_id: string
          request_type: string
          status: string
          submitted_by: string
          submitted_by_email: string | null
          submitted_by_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          admin_notes?: string | null
          created_at?: string
          description?: string | null
          id?: string
          org_id: string
          request_type?: string
          status?: string
          submitted_by: string
          submitted_by_email?: string | null
          submitted_by_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          admin_notes?: string | null
          created_at?: string
          description?: string | null
          id?: string
          org_id?: string
          request_type?: string
          status?: string
          submitted_by?: string
          submitted_by_email?: string | null
          submitted_by_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_requests_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_requests_submitted_by_id_fkey"
            columns: ["submitted_by_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      insurance_documents: {
        Row: {
          company_id: string | null
          created_at: string
          doc_kind: string
          email_from: string | null
          email_subject: string | null
          extracted_company_name: string | null
          extraction: Json | null
          extraction_error: string | null
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          org_id: string
          received_at: string
          source: string
          status: string
          storage_bucket: string
          storage_path: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          doc_kind?: string
          email_from?: string | null
          email_subject?: string | null
          extracted_company_name?: string | null
          extraction?: Json | null
          extraction_error?: string | null
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          org_id?: string
          received_at?: string
          source: string
          status?: string
          storage_bucket?: string
          storage_path: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          doc_kind?: string
          email_from?: string | null
          email_subject?: string | null
          extracted_company_name?: string | null
          extraction?: Json | null
          extraction_error?: string | null
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          org_id?: string
          received_at?: string
          source?: string
          status?: string
          storage_bucket?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "insurance_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      insurance_policies: {
        Row: {
          carrier: string | null
          company_id: string
          created_at: string
          document_id: string | null
          effective_date: string | null
          expiration_date: string
          id: string
          limits: Json | null
          policy_number: string | null
          reminder_sent_at: string | null
          type: Database["public"]["Enums"]["insurance_type"]
        }
        Insert: {
          carrier?: string | null
          company_id: string
          created_at?: string
          document_id?: string | null
          effective_date?: string | null
          expiration_date: string
          id?: string
          limits?: Json | null
          policy_number?: string | null
          reminder_sent_at?: string | null
          type: Database["public"]["Enums"]["insurance_type"]
        }
        Update: {
          carrier?: string | null
          company_id?: string
          created_at?: string
          document_id?: string | null
          effective_date?: string | null
          expiration_date?: string
          id?: string
          limits?: Json | null
          policy_number?: string | null
          reminder_sent_at?: string | null
          type?: Database["public"]["Enums"]["insurance_type"]
        }
        Relationships: [
          {
            foreignKeyName: "insurance_policies_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "insurance_policies_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "insurance_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          category: string
          channel: string
          company_id: string | null
          created_at: string
          enabled: boolean
          id: string
          profile_id: string | null
          updated_at: string
        }
        Insert: {
          category: string
          channel: string
          company_id?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          profile_id?: string | null
          updated_at?: string
        }
        Update: {
          category?: string
          channel?: string
          company_id?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          profile_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_preferences_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          email_sent_at: string | null
          id: string
          link_url: string | null
          read_at: string | null
          recipient_id: string
          title: string
          type: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          email_sent_at?: string | null
          id?: string
          link_url?: string | null
          read_at?: string | null
          recipient_id: string
          title: string
          type: string
        }
        Update: {
          body?: string | null
          created_at?: string
          email_sent_at?: string | null
          id?: string
          link_url?: string | null
          read_at?: string | null
          recipient_id?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          member_role: string
          org_id: string
          profile_id: string
        }
        Insert: {
          created_at?: string
          member_role?: string
          org_id: string
          profile_id: string
        }
        Update: {
          created_at?: string
          member_role?: string
          org_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          settings: Json
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          settings?: Json
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          settings?: Json
          slug?: string
        }
        Relationships: []
      }
      outlook_sync_state: {
        Row: {
          delta_link: string | null
          folder: string
          mailbox: string
          updated_at: string
        }
        Insert: {
          delta_link?: string | null
          folder: string
          mailbox: string
          updated_at?: string
        }
        Update: {
          delta_link?: string | null
          folder?: string
          mailbox?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_audit: {
        Row: {
          action: string
          actor_id: string | null
          after: Json | null
          before: Json | null
          created_at: string
          id: string
          payment_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          payment_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json | null
          before?: Json | null
          created_at?: string
          id?: string
          payment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_audit_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_audit_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "project_payments"
            referencedColumns: ["id"]
          },
        ]
      }
      po_attachments: {
        Row: {
          caption: string | null
          created_at: string
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          position: number
          project_file_id: string | null
          purchase_order_id: string
          storage_bucket: string
          storage_path: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          project_file_id?: string | null
          purchase_order_id: string
          storage_bucket?: string
          storage_path: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          project_file_id?: string | null
          purchase_order_id?: string
          storage_bucket?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "po_attachments_project_file_id_fkey"
            columns: ["project_file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_attachments_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      po_comments: {
        Row: {
          author_name: string
          author_profile_id: string | null
          body: string
          created_at: string
          id: string
          purchase_order_id: string
        }
        Insert: {
          author_name: string
          author_profile_id?: string | null
          body: string
          created_at?: string
          id?: string
          purchase_order_id: string
        }
        Update: {
          author_name?: string
          author_profile_id?: string | null
          body?: string
          created_at?: string
          id?: string
          purchase_order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "po_comments_author_profile_id_fkey"
            columns: ["author_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_comments_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      po_line_items: {
        Row: {
          cost_code_id: string | null
          created_at: string
          description: string
          id: string
          position: number
          purchase_order_id: string
          quantity: number
          unit: string | null
          unit_cost: number
        }
        Insert: {
          cost_code_id?: string | null
          created_at?: string
          description: string
          id?: string
          position?: number
          purchase_order_id: string
          quantity?: number
          unit?: string | null
          unit_cost?: number
        }
        Update: {
          cost_code_id?: string | null
          created_at?: string
          description?: string
          id?: string
          position?: number
          purchase_order_id?: string
          quantity?: number
          unit?: string | null
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "po_line_items_cost_code_id_fkey"
            columns: ["cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_line_items_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          company_id: string | null
          created_at: string
          disclaimer_accepted_at: string | null
          disclaimer_version: string | null
          email: string | null
          email_digest_pref: Database["public"]["Enums"]["email_digest_pref"]
          entra_user_id: string | null
          financial_access: boolean
          full_name: string
          id: string
          last_digest_at: string | null
          notifications_enabled: boolean
          phone: string | null
          quo_phone_number: string | null
          quo_phone_number_id: string | null
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          disclaimer_accepted_at?: string | null
          disclaimer_version?: string | null
          email?: string | null
          email_digest_pref?: Database["public"]["Enums"]["email_digest_pref"]
          entra_user_id?: string | null
          financial_access?: boolean
          full_name?: string
          id: string
          last_digest_at?: string | null
          notifications_enabled?: boolean
          phone?: string | null
          quo_phone_number?: string | null
          quo_phone_number_id?: string | null
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          company_id?: string | null
          created_at?: string
          disclaimer_accepted_at?: string | null
          disclaimer_version?: string | null
          email?: string | null
          email_digest_pref?: Database["public"]["Enums"]["email_digest_pref"]
          entra_user_id?: string | null
          financial_access?: boolean
          full_name?: string
          id?: string
          last_digest_at?: string | null
          notifications_enabled?: boolean
          phone?: string | null
          quo_phone_number?: string | null
          quo_phone_number_id?: string | null
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      project_budget_lines: {
        Row: {
          budget_amount: number
          cost_code_id: string
          created_at: string
          created_by: string | null
          forecast_override: number | null
          id: string
          project_id: string
          updated_at: string
        }
        Insert: {
          budget_amount?: number
          cost_code_id: string
          created_at?: string
          created_by?: string | null
          forecast_override?: number | null
          id?: string
          project_id: string
          updated_at?: string
        }
        Update: {
          budget_amount?: number
          cost_code_id?: string
          created_at?: string
          created_by?: string | null
          forecast_override?: number | null
          id?: string
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_budget_lines_cost_code_id_fkey"
            columns: ["cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_budget_lines_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_budget_lines_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_cost_actuals: {
        Row: {
          amount: number
          as_of: string | null
          cost_code_id: string
          created_at: string
          id: string
          project_id: string
          source: string
          updated_at: string
        }
        Insert: {
          amount?: number
          as_of?: string | null
          cost_code_id: string
          created_at?: string
          id?: string
          project_id: string
          source?: string
          updated_at?: string
        }
        Update: {
          amount?: number
          as_of?: string | null
          cost_code_id?: string
          created_at?: string
          id?: string
          project_id?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_cost_actuals_cost_code_id_fkey"
            columns: ["cost_code_id"]
            isOneToOne: false
            referencedRelation: "cost_codes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_cost_actuals_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_files: {
        Row: {
          archived_at: string | null
          category: Database["public"]["Enums"]["file_category"]
          client_visible: boolean
          created_at: string
          description: string | null
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          is_current: boolean
          parent_file_id: string | null
          project_id: string
          storage_bucket: string
          storage_path: string
          tags: string[]
          title: string
          uploaded_by: string | null
          version: number
        }
        Insert: {
          archived_at?: string | null
          category?: Database["public"]["Enums"]["file_category"]
          client_visible?: boolean
          created_at?: string
          description?: string | null
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          is_current?: boolean
          parent_file_id?: string | null
          project_id: string
          storage_bucket?: string
          storage_path: string
          tags?: string[]
          title: string
          uploaded_by?: string | null
          version?: number
        }
        Update: {
          archived_at?: string | null
          category?: Database["public"]["Enums"]["file_category"]
          client_visible?: boolean
          created_at?: string
          description?: string | null
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          is_current?: boolean
          parent_file_id?: string | null
          project_id?: string
          storage_bucket?: string
          storage_path?: string
          tags?: string[]
          title?: string
          uploaded_by?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_files_parent_file_id_fkey"
            columns: ["parent_file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_files_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_files_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_history: {
        Row: {
          action: string
          actor_id: string | null
          actor_name: string | null
          changes: Json | null
          created_at: string
          entity_id: string | null
          entity_label: string | null
          entity_type: string
          id: string
          project_id: string
          txid: number
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_name?: string | null
          changes?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_label?: string | null
          entity_type: string
          id?: string
          project_id: string
          txid?: number
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_name?: string | null
          changes?: Json | null
          created_at?: string
          entity_id?: string | null
          entity_label?: string | null
          entity_type?: string
          id?: string
          project_id?: string
          txid?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_history_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          created_at: string
          profile_id: string
          project_id: string
          role_on_project: string | null
        }
        Insert: {
          created_at?: string
          profile_id: string
          project_id: string
          role_on_project?: string | null
        }
        Update: {
          created_at?: string
          profile_id?: string
          project_id?: string
          role_on_project?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_payments: {
        Row: {
          amount: number
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          notes: string | null
          paid_on: string
          project_id: string
          recorded_by: string | null
          reference: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          notes?: string | null
          paid_on?: string
          project_id: string
          recorded_by?: string | null
          reference?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          notes?: string | null
          paid_on?: string
          project_id?: string
          recorded_by?: string | null
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_payments_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_payments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_payments_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      project_role_members: {
        Row: {
          company_id: string | null
          profile_id: string | null
          project_id: string
          role_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          company_id?: string | null
          profile_id?: string | null
          project_id: string
          role_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          company_id?: string | null
          profile_id?: string | null
          project_id?: string
          role_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_role_members_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_role_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_role_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_role_members_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_role_members_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          address: string | null
          attributes: Json
          baseline_set_at: string | null
          baseline_set_by: string | null
          client_company_id: string | null
          client_email: string | null
          client_email_2: string | null
          client_name: string | null
          client_name_2: string | null
          client_phone: string | null
          client_phone_2: string | null
          contract_price: number | null
          cost_plus: boolean
          created_at: string
          created_by: string | null
          crm_status: string | null
          crm_status_synced_at: string | null
          dashboard_pulled_at: string | null
          dashboard_url: string | null
          id: string
          is_template: boolean
          labels: string[]
          latitude: number | null
          longitude: number | null
          name: string
          notes: string | null
          org_id: string
          project_manager: string | null
          project_number: string
          project_type: Database["public"]["Enums"]["project_type"] | null
          qbo_customer_id: string | null
          qbo_customer_name: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["project_status"]
          warranty_end_date: string | null
        }
        Insert: {
          address?: string | null
          attributes?: Json
          baseline_set_at?: string | null
          baseline_set_by?: string | null
          client_company_id?: string | null
          client_email?: string | null
          client_email_2?: string | null
          client_name?: string | null
          client_name_2?: string | null
          client_phone?: string | null
          client_phone_2?: string | null
          contract_price?: number | null
          cost_plus?: boolean
          created_at?: string
          created_by?: string | null
          crm_status?: string | null
          crm_status_synced_at?: string | null
          dashboard_pulled_at?: string | null
          dashboard_url?: string | null
          id?: string
          is_template?: boolean
          labels?: string[]
          latitude?: number | null
          longitude?: number | null
          name: string
          notes?: string | null
          org_id?: string
          project_manager?: string | null
          project_number: string
          project_type?: Database["public"]["Enums"]["project_type"] | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          warranty_end_date?: string | null
        }
        Update: {
          address?: string | null
          attributes?: Json
          baseline_set_at?: string | null
          baseline_set_by?: string | null
          client_company_id?: string | null
          client_email?: string | null
          client_email_2?: string | null
          client_name?: string | null
          client_name_2?: string | null
          client_phone?: string | null
          client_phone_2?: string | null
          contract_price?: number | null
          cost_plus?: boolean
          created_at?: string
          created_by?: string | null
          crm_status?: string | null
          crm_status_synced_at?: string | null
          dashboard_pulled_at?: string | null
          dashboard_url?: string | null
          id?: string
          is_template?: boolean
          labels?: string[]
          latitude?: number | null
          longitude?: number | null
          name?: string
          notes?: string | null
          org_id?: string
          project_manager?: string | null
          project_number?: string
          project_type?: Database["public"]["Enums"]["project_type"] | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          warranty_end_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_baseline_set_by_fkey"
            columns: ["baseline_set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_client_company_id_fkey"
            columns: ["client_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          approval_deadline: string | null
          approved_at: string | null
          approved_by_profile_id: string | null
          approved_signature: string | null
          company_id: string
          created_at: string
          created_by: string | null
          custom_number: string | null
          decline_reason: string | null
          declined_at: string | null
          flat_fee: boolean
          flat_total: number | null
          id: string
          number: number
          project_id: string
          released_at: string | null
          scope: string | null
          source_bid_recipient_id: string | null
          source_decision_id: string | null
          status: Database["public"]["Enums"]["po_status"]
          title: string
          token: string | null
          updated_at: string
          voided_at: string | null
          work_complete: boolean
          work_complete_at: string | null
        }
        Insert: {
          approval_deadline?: string | null
          approved_at?: string | null
          approved_by_profile_id?: string | null
          approved_signature?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          custom_number?: string | null
          decline_reason?: string | null
          declined_at?: string | null
          flat_fee?: boolean
          flat_total?: number | null
          id?: string
          number: number
          project_id: string
          released_at?: string | null
          scope?: string | null
          source_bid_recipient_id?: string | null
          source_decision_id?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          title: string
          token?: string | null
          updated_at?: string
          voided_at?: string | null
          work_complete?: boolean
          work_complete_at?: string | null
        }
        Update: {
          approval_deadline?: string | null
          approved_at?: string | null
          approved_by_profile_id?: string | null
          approved_signature?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          custom_number?: string | null
          decline_reason?: string | null
          declined_at?: string | null
          flat_fee?: boolean
          flat_total?: number | null
          id?: string
          number?: number
          project_id?: string
          released_at?: string | null
          scope?: string | null
          source_bid_recipient_id?: string | null
          source_decision_id?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          title?: string
          token?: string | null
          updated_at?: string
          voided_at?: string | null
          work_complete?: boolean
          work_complete_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_approved_by_profile_id_fkey"
            columns: ["approved_by_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_source_bid_recipient_id_fkey"
            columns: ["source_bid_recipient_id"]
            isOneToOne: false
            referencedRelation: "bid_recipients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_source_decision_id_fkey"
            columns: ["source_decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      purchasing_templates: {
        Row: {
          created_at: string
          created_by: string | null
          flat_fee: boolean
          id: string
          line_items: Json
          name: string
          org_id: string
          scope: string | null
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          flat_fee?: boolean
          id?: string
          line_items?: Json
          name: string
          org_id: string
          scope?: string | null
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          flat_fee?: boolean
          id?: string
          line_items?: Json
          name?: string
          org_id?: string
          scope?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchasing_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchasing_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      qbo_connection: {
        Row: {
          access_token: string
          access_token_expires_at: string
          company_name: string | null
          connected_by: string | null
          created_at: string
          environment: string
          org_id: string
          realm_id: string
          refresh_token: string
          refresh_token_expires_at: string
          updated_at: string
        }
        Insert: {
          access_token: string
          access_token_expires_at: string
          company_name?: string | null
          connected_by?: string | null
          created_at?: string
          environment?: string
          org_id?: string
          realm_id: string
          refresh_token: string
          refresh_token_expires_at: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          access_token_expires_at?: string
          company_name?: string | null
          connected_by?: string | null
          created_at?: string
          environment?: string
          org_id?: string
          realm_id?: string
          refresh_token?: string
          refresh_token_expires_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "qbo_connection_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qbo_connection_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      qbo_invoices: {
        Row: {
          balance: number
          created_at: string
          customer_memo: string | null
          doc_number: string | null
          due_date: string | null
          id: string
          invoice_link: string | null
          last_synced_at: string
          project_id: string
          qbo_invoice_id: string
          qbo_realm_id: string
          status: string
          total: number
          txn_date: string | null
          updated_at: string
        }
        Insert: {
          balance?: number
          created_at?: string
          customer_memo?: string | null
          doc_number?: string | null
          due_date?: string | null
          id?: string
          invoice_link?: string | null
          last_synced_at?: string
          project_id: string
          qbo_invoice_id: string
          qbo_realm_id: string
          status?: string
          total?: number
          txn_date?: string | null
          updated_at?: string
        }
        Update: {
          balance?: number
          created_at?: string
          customer_memo?: string | null
          doc_number?: string | null
          due_date?: string | null
          id?: string
          invoice_link?: string | null
          last_synced_at?: string
          project_id?: string
          qbo_invoice_id?: string
          qbo_realm_id?: string
          status?: string
          total?: number
          txn_date?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      qbo_po_sync: {
        Row: {
          created_at: string
          doc_number: string | null
          last_error: string | null
          purchase_order_id: string
          qbo_po_id: string | null
          qbo_realm_id: string
          status: string
          sync_token: string | null
          synced_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          doc_number?: string | null
          last_error?: string | null
          purchase_order_id: string
          qbo_po_id?: string | null
          qbo_realm_id: string
          status?: string
          sync_token?: string | null
          synced_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          doc_number?: string | null
          last_error?: string | null
          purchase_order_id?: string
          qbo_po_id?: string | null
          qbo_realm_id?: string
          status?: string
          sync_token?: string | null
          synced_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      rental_items: {
        Row: {
          created_at: string
          created_by: string | null
          date_noted: string | null
          due_date: string | null
          id: string
          no_action: boolean
          position: number
          rental_property_id: string
          resolution: string | null
          status: Database["public"]["Enums"]["schedule_item_status"]
          title: string
          updated_at: string
          who_fixing: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          date_noted?: string | null
          due_date?: string | null
          id?: string
          no_action?: boolean
          position?: number
          rental_property_id: string
          resolution?: string | null
          status?: Database["public"]["Enums"]["schedule_item_status"]
          title: string
          updated_at?: string
          who_fixing?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          date_noted?: string | null
          due_date?: string | null
          id?: string
          no_action?: boolean
          position?: number
          rental_property_id?: string
          resolution?: string | null
          status?: Database["public"]["Enums"]["schedule_item_status"]
          title?: string
          updated_at?: string
          who_fixing?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rental_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rental_items_rental_property_id_fkey"
            columns: ["rental_property_id"]
            isOneToOne: false
            referencedRelation: "rental_properties"
            referencedColumns: ["id"]
          },
        ]
      }
      rental_properties: {
        Row: {
          address: string
          created_at: string
          crm_rental_id: string | null
          id: string
          lease_status: string | null
          org_id: string
          property_owner: string | null
          synced_at: string
          tenant_name: string | null
          updated_at: string
        }
        Insert: {
          address: string
          created_at?: string
          crm_rental_id?: string | null
          id?: string
          lease_status?: string | null
          org_id: string
          property_owner?: string | null
          synced_at?: string
          tenant_name?: string | null
          updated_at?: string
        }
        Update: {
          address?: string
          created_at?: string
          crm_rental_id?: string | null
          id?: string
          lease_status?: string | null
          org_id?: string
          property_owner?: string | null
          synced_at?: string
          tenant_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rental_properties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          id: string
          kind: string
          name: string
          org_id: string
          position: number
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          name: string
          org_id: string
          position?: number
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          name?: string
          org_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "roles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_assignments: {
        Row: {
          company_id: string | null
          created_at: string
          id: string
          notified_at: string | null
          profile_id: string | null
          role_id: string | null
          schedule_item_id: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          id?: string
          notified_at?: string | null
          profile_id?: string | null
          role_id?: string | null
          schedule_item_id: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          id?: string
          notified_at?: string | null
          profile_id?: string | null
          role_id?: string | null
          schedule_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_assignments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_assignments_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_assignments_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_delays: {
        Row: {
          delay_days: number
          id: string
          logged_at: string
          logged_by: string | null
          notes: string | null
          reason_category: string
          schedule_item_id: string
        }
        Insert: {
          delay_days: number
          id?: string
          logged_at?: string
          logged_by?: string | null
          notes?: string | null
          reason_category: string
          schedule_item_id: string
        }
        Update: {
          delay_days?: number
          id?: string
          logged_at?: string
          logged_by?: string | null
          notes?: string | null
          reason_category?: string
          schedule_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_delays_logged_by_fkey"
            columns: ["logged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_delays_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_item_attachments: {
        Row: {
          caption: string | null
          created_at: string
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          position: number
          schedule_item_id: string
          storage_bucket: string
          storage_path: string
          tags: string[]
          uploaded_by: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          schedule_item_id: string
          storage_bucket?: string
          storage_path: string
          tags?: string[]
          uploaded_by?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          position?: number
          schedule_item_id?: string
          storage_bucket?: string
          storage_path?: string
          tags?: string[]
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_item_attachments_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_item_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_item_comments: {
        Row: {
          author_id: string | null
          author_name: string
          body: string
          created_at: string
          id: string
          schedule_item_id: string
        }
        Insert: {
          author_id?: string | null
          author_name: string
          body: string
          created_at?: string
          id?: string
          schedule_item_id: string
        }
        Update: {
          author_id?: string | null
          author_name?: string
          body?: string
          created_at?: string
          id?: string
          schedule_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_item_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_item_comments_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_items: {
        Row: {
          baseline_end_date: string | null
          baseline_start_date: string | null
          created_at: string
          created_by: string
          description: string | null
          due_date: string | null
          duration_days: number | null
          end_date: string | null
          exclude_from_critical_path: boolean
          id: string
          kind: Database["public"]["Enums"]["schedule_item_kind"]
          milestone: Database["public"]["Enums"]["schedule_milestone"] | null
          parent_anchor:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          parent_id: string | null
          parent_offset_days: number | null
          position: number
          priority: Database["public"]["Enums"]["todo_priority"] | null
          project_id: string
          recurrence_parent_id: string | null
          recurrence_rule: Json | null
          source_decision_id: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["schedule_item_status"]
          template_tags: string[]
          title: string
          updated_at: string
          warranty_date_noted: string | null
          warranty_no_action: boolean
          warranty_resolution: string | null
          warranty_who_fixing: string | null
        }
        Insert: {
          baseline_end_date?: string | null
          baseline_start_date?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          due_date?: string | null
          duration_days?: number | null
          end_date?: string | null
          exclude_from_critical_path?: boolean
          id?: string
          kind: Database["public"]["Enums"]["schedule_item_kind"]
          milestone?: Database["public"]["Enums"]["schedule_milestone"] | null
          parent_anchor?:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          parent_id?: string | null
          parent_offset_days?: number | null
          position?: number
          priority?: Database["public"]["Enums"]["todo_priority"] | null
          project_id: string
          recurrence_parent_id?: string | null
          recurrence_rule?: Json | null
          source_decision_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["schedule_item_status"]
          template_tags?: string[]
          title: string
          updated_at?: string
          warranty_date_noted?: string | null
          warranty_no_action?: boolean
          warranty_resolution?: string | null
          warranty_who_fixing?: string | null
        }
        Update: {
          baseline_end_date?: string | null
          baseline_start_date?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          due_date?: string | null
          duration_days?: number | null
          end_date?: string | null
          exclude_from_critical_path?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["schedule_item_kind"]
          milestone?: Database["public"]["Enums"]["schedule_milestone"] | null
          parent_anchor?:
            | Database["public"]["Enums"]["schedule_parent_anchor"]
            | null
          parent_id?: string | null
          parent_offset_days?: number | null
          position?: number
          priority?: Database["public"]["Enums"]["todo_priority"] | null
          project_id?: string
          recurrence_parent_id?: string | null
          recurrence_rule?: Json | null
          source_decision_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["schedule_item_status"]
          template_tags?: string[]
          title?: string
          updated_at?: string
          warranty_date_noted?: string | null
          warranty_no_action?: boolean
          warranty_resolution?: string | null
          warranty_who_fixing?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "schedule_items_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_items_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_items_recurrence_parent_id_fkey"
            columns: ["recurrence_parent_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_items_source_decision_id_fkey"
            columns: ["source_decision_id"]
            isOneToOne: false
            referencedRelation: "decisions"
            referencedColumns: ["id"]
          },
        ]
      }
      schedule_predecessors: {
        Row: {
          created_at: string
          dep_type: Database["public"]["Enums"]["dependency_type"]
          id: string
          item_id: string
          lag_days: number
          predecessor_id: string
        }
        Insert: {
          created_at?: string
          dep_type?: Database["public"]["Enums"]["dependency_type"]
          id?: string
          item_id: string
          lag_days?: number
          predecessor_id: string
        }
        Update: {
          created_at?: string
          dep_type?: Database["public"]["Enums"]["dependency_type"]
          id?: string
          item_id?: string
          lag_days?: number
          predecessor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedule_predecessors_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "schedule_predecessors_predecessor_id_fkey"
            columns: ["predecessor_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
        ]
      }
      todo_checklist_items: {
        Row: {
          assignee_company_id: string | null
          assignee_profile_id: string | null
          assignee_role_id: string | null
          created_at: string
          id: string
          is_done: boolean
          label: string
          position: number
          schedule_item_id: string
        }
        Insert: {
          assignee_company_id?: string | null
          assignee_profile_id?: string | null
          assignee_role_id?: string | null
          created_at?: string
          id?: string
          is_done?: boolean
          label: string
          position?: number
          schedule_item_id: string
        }
        Update: {
          assignee_company_id?: string | null
          assignee_profile_id?: string | null
          assignee_role_id?: string | null
          created_at?: string
          id?: string
          is_done?: boolean
          label?: string
          position?: number
          schedule_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "todo_checklist_items_assignee_company_id_fkey"
            columns: ["assignee_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "todo_checklist_items_assignee_profile_id_fkey"
            columns: ["assignee_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "todo_checklist_items_assignee_role_id_fkey"
            columns: ["assignee_role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "todo_checklist_items_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
        ]
      }
      utility_requests: {
        Row: {
          created_at: string
          created_by: string | null
          crm_project_id: string | null
          form_data: Json
          generated_file_paths: string[]
          id: string
          job_label: string | null
          paid_at: string | null
          payment_url: string | null
          project_id: string | null
          provider: Database["public"]["Enums"]["utility_provider"]
          status: Database["public"]["Enums"]["utility_request_status"]
          submitted_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          crm_project_id?: string | null
          form_data?: Json
          generated_file_paths?: string[]
          id?: string
          job_label?: string | null
          paid_at?: string | null
          payment_url?: string | null
          project_id?: string | null
          provider?: Database["public"]["Enums"]["utility_provider"]
          status?: Database["public"]["Enums"]["utility_request_status"]
          submitted_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          crm_project_id?: string | null
          form_data?: Json
          generated_file_paths?: string[]
          id?: string
          job_label?: string | null
          paid_at?: string | null
          payment_url?: string | null
          project_id?: string | null
          provider?: Database["public"]["Enums"]["utility_provider"]
          status?: Database["public"]["Enums"]["utility_request_status"]
          submitted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_requests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      append_checklist_item: {
        Args: { p_label: string; p_schedule_item_id: string }
        Returns: string
      }
      award_bid: {
        Args: { p_create_po: boolean; p_recipient: string }
        Returns: Json
      }
      claim_deleted_item: {
        Args: { p_id: string }
        Returns: {
          deleted_at: string
          deleted_by: string | null
          deleted_by_name: string | null
          entity_id: string
          entity_label: string | null
          entity_type: string
          id: string
          payload: Json
          project_id: string
          purge_claimed_at: string | null
          restored_at: string | null
          restored_by: string | null
          storage_paths: string[]
        }[]
        SetofOptions: {
          from: "*"
          to: "deleted_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_expired_deleted_items: {
        Args: { p_limit?: number; p_project: string }
        Returns: {
          id: string
          storage_paths: string[]
          was_restored: boolean
        }[]
      }
      claim_restored_entities: {
        Args: { p_entity_ids: string[]; p_project: string }
        Returns: undefined
      }
      client_decide_decision: {
        Args: { p_action: string; p_choice_id?: string; p_decision_id: string }
        Returns: Json
      }
      current_company_id: { Args: never; Returns: string }
      current_org_ids: { Args: never; Returns: string[] }
      current_role_name: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      finalize_purged_deleted_items: {
        Args: { p_ids: string[]; p_project: string }
        Returns: undefined
      }
      is_member_of_project: { Args: { p_project: string }; Returns: boolean }
      is_org_member: { Args: { org: string }; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      match_contacts_by_email: {
        Args: { p: string }
        Returns: {
          company_id: string
          display_name: string
          kind: string
          profile_id: string
          project_id: string
        }[]
      }
      match_contacts_by_phone: {
        Args: { p: string }
        Returns: {
          company_id: string
          display_name: string
          kind: string
          profile_id: string
          project_id: string
        }[]
      }
      next_bid_package_number: { Args: { p_project: string }; Returns: number }
      next_decision_number: { Args: { p_project: string }; Returns: number }
      next_po_number: { Args: { p_project: string }; Returns: number }
      normalize_phone: { Args: { p: string }; Returns: string }
      save_company_with_trades: {
        Args: {
          p_address: string
          p_email: string
          p_id: string
          p_name: string
          p_notes: string
          p_phone: string
          p_trades: string[]
          p_type: Database["public"]["Enums"]["company_type"]
        }
        Returns: string
      }
      set_project_label: {
        Args: { p_add: boolean; p_ids: string[]; p_label: string }
        Returns: number
      }
      set_schedule_baseline: { Args: { p_project: string }; Returns: undefined }
      strip_template_tag: { Args: { p_tag: string }; Returns: number }
      template_tag_usage: {
        Args: never
        Returns: {
          tag: string
          uses: number
        }[]
      }
      trade_sees_assignment_via_role: {
        Args: { p_item: string; p_role: string }
        Returns: boolean
      }
      trade_sees_decision: { Args: { p_decision: string }; Returns: boolean }
      trade_sees_item_via_role: { Args: { p_item: string }; Returns: boolean }
      trade_sees_project: { Args: { p_project: string }; Returns: boolean }
      trash_purge_allowed: { Args: never; Returns: boolean }
      unclaim_deleted_item: { Args: { p_id: string }; Returns: undefined }
      unclaim_purged_deleted_items: {
        Args: { p_ids: string[]; p_project: string }
        Returns: undefined
      }
      unreferenced_storage_paths: {
        Args: { p_paths: string[] }
        Returns: string[]
      }
      validate_media_tags: { Args: { p_tags: string[] }; Returns: undefined }
    }
    Enums: {
      bid_package_status: "draft" | "sent" | "awarded" | "closed"
      bid_recipient_status: "invited" | "submitted" | "declined" | "awarded"
      comm_channel: "email" | "sms" | "call"
      comm_direction: "outbound" | "inbound"
      comm_status: "logged" | "needs_review" | "ignored"
      company_type: "sub" | "vendor" | "client"
      daily_log_visibility: "internal" | "client"
      decision_kind: "change_order" | "selection"
      decision_status: "draft" | "pending_client" | "approved" | "rejected"
      delay_reason:
        | "weather"
        | "sub"
        | "material"
        | "owner_decision"
        | "permit"
        | "other"
      dependency_type: "FS" | "SS" | "FF" | "SF"
      email_digest_pref: "immediate" | "daily" | "off"
      file_category:
        | "house_plans"
        | "plot_plan"
        | "permit"
        | "contract"
        | "other"
        | "quotes"
      insurance_type: "general_liability" | "workers_comp" | "auto" | "umbrella"
      payment_method: "check" | "wire" | "card" | "cash" | "other"
      po_status: "draft" | "released" | "approved" | "declined" | "void"
      project_status:
        | "upcoming"
        | "in_work"
        | "complete"
        | "warranty"
        | "inventory"
        | "paused"
        | "cancelled"
      project_type:
        | "residential_new"
        | "residential_remodel"
        | "commercial_new"
        | "commercial_remodel"
      schedule_item_kind: "work" | "todo"
      schedule_item_status:
        | "not_started"
        | "in_progress"
        | "complete"
        | "delayed"
      schedule_milestone: "job_start" | "substantial_completion"
      schedule_parent_anchor: "start" | "end"
      todo_priority: "low" | "medium" | "high"
      user_role: "staff" | "trade" | "client"
      utility_provider: "central_arkansas_water" | "lumber_one"
      utility_request_status:
        | "draft"
        | "submitted"
        | "awaiting_payment"
        | "paid"
        | "complete"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      bid_package_status: ["draft", "sent", "awarded", "closed"],
      bid_recipient_status: ["invited", "submitted", "declined", "awarded"],
      comm_channel: ["email", "sms", "call"],
      comm_direction: ["outbound", "inbound"],
      comm_status: ["logged", "needs_review", "ignored"],
      company_type: ["sub", "vendor", "client"],
      daily_log_visibility: ["internal", "client"],
      decision_kind: ["change_order", "selection"],
      decision_status: ["draft", "pending_client", "approved", "rejected"],
      delay_reason: [
        "weather",
        "sub",
        "material",
        "owner_decision",
        "permit",
        "other",
      ],
      dependency_type: ["FS", "SS", "FF", "SF"],
      email_digest_pref: ["immediate", "daily", "off"],
      file_category: [
        "house_plans",
        "plot_plan",
        "permit",
        "contract",
        "other",
        "quotes",
      ],
      insurance_type: ["general_liability", "workers_comp", "auto", "umbrella"],
      payment_method: ["check", "wire", "card", "cash", "other"],
      po_status: ["draft", "released", "approved", "declined", "void"],
      project_status: [
        "upcoming",
        "in_work",
        "complete",
        "warranty",
        "inventory",
        "paused",
        "cancelled",
      ],
      project_type: [
        "residential_new",
        "residential_remodel",
        "commercial_new",
        "commercial_remodel",
      ],
      schedule_item_kind: ["work", "todo"],
      schedule_item_status: [
        "not_started",
        "in_progress",
        "complete",
        "delayed",
      ],
      schedule_milestone: ["job_start", "substantial_completion"],
      schedule_parent_anchor: ["start", "end"],
      todo_priority: ["low", "medium", "high"],
      user_role: ["staff", "trade", "client"],
      utility_provider: ["central_arkansas_water", "lumber_one"],
      utility_request_status: [
        "draft",
        "submitted",
        "awaiting_payment",
        "paid",
        "complete",
      ],
    },
  },
} as const
