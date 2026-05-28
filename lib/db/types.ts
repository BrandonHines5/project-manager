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
      companies: {
        Row: {
          address: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          trade_category: string | null
          type: Database["public"]["Enums"]["company_type"]
        }
        Insert: {
          address?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          trade_category?: string | null
          type: Database["public"]["Enums"]["company_type"]
        }
        Update: {
          address?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          trade_category?: string | null
          type?: Database["public"]["Enums"]["company_type"]
        }
        Relationships: []
      }
      cost_codes: {
        Row: {
          code: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          name: string
          position: number
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          position?: number
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          position?: number
        }
        Relationships: []
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
          created_by: string | null
          id: string
          log_date: string
          notes: string | null
          project_id: string
          updated_at: string
          visibility: Database["public"]["Enums"]["daily_log_visibility"]
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          log_date?: string
          notes?: string | null
          project_id: string
          updated_at?: string
          visibility?: Database["public"]["Enums"]["daily_log_visibility"]
        }
        Update: {
          created_at?: string
          created_by?: string | null
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
            foreignKeyName: "decision_cost_items_choice_id_fkey"
            columns: ["choice_id"]
            isOneToOne: false
            referencedRelation: "decision_choices"
            referencedColumns: ["id"]
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
      decision_followup_templates: {
        Row: {
          assignee_company_id: string | null
          assignee_profile_id: string | null
          created_at: string
          decision_id: string
          due_offset_days: number
          id: string
          notes: string | null
          position: number
          title: string
        }
        Insert: {
          assignee_company_id?: string | null
          assignee_profile_id?: string | null
          created_at?: string
          decision_id: string
          due_offset_days?: number
          id?: string
          notes?: string | null
          position?: number
          title: string
        }
        Update: {
          assignee_company_id?: string | null
          assignee_profile_id?: string | null
          created_at?: string
          decision_id?: string
          due_offset_days?: number
          id?: string
          notes?: string | null
          position?: number
          title?: string
        }
        Relationships: [
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
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          kind: Database["public"]["Enums"]["decision_kind"]
          markup_percent: number
          number: number
          project_id: string
          selected_choice_id: string | null
          status: Database["public"]["Enums"]["decision_status"]
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
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          kind: Database["public"]["Enums"]["decision_kind"]
          markup_percent?: number
          number: number
          project_id: string
          selected_choice_id?: string | null
          status?: Database["public"]["Enums"]["decision_status"]
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
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["decision_kind"]
          markup_percent?: number
          number?: number
          project_id?: string
          selected_choice_id?: string | null
          status?: Database["public"]["Enums"]["decision_status"]
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
      notifications: {
        Row: {
          body: string | null
          created_at: string
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
      profiles: {
        Row: {
          company_id: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          company_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
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
      project_files: {
        Row: {
          category: Database["public"]["Enums"]["file_category"]
          created_at: string
          description: string | null
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          project_id: string
          storage_bucket: string
          storage_path: string
          title: string
          uploaded_by: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["file_category"]
          created_at?: string
          description?: string | null
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          project_id: string
          storage_bucket?: string
          storage_path: string
          title: string
          uploaded_by?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["file_category"]
          created_at?: string
          description?: string | null
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          project_id?: string
          storage_bucket?: string
          storage_path?: string
          title?: string
          uploaded_by?: string | null
        }
        Relationships: [
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
      projects: {
        Row: {
          address: string | null
          client_company_id: string | null
          client_email: string | null
          client_name: string | null
          client_phone: string | null
          contract_price: number | null
          created_at: string
          created_by: string | null
          dashboard_pulled_at: string | null
          dashboard_url: string | null
          id: string
          latitude: number | null
          longitude: number | null
          name: string
          notes: string | null
          project_number: string
          start_date: string | null
          status: Database["public"]["Enums"]["project_status"]
          target_completion_date: string | null
        }
        Insert: {
          address?: string | null
          client_company_id?: string | null
          client_email?: string | null
          client_name?: string | null
          client_phone?: string | null
          contract_price?: number | null
          created_at?: string
          created_by?: string | null
          dashboard_pulled_at?: string | null
          dashboard_url?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          name: string
          notes?: string | null
          project_number: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          target_completion_date?: string | null
        }
        Update: {
          address?: string | null
          client_company_id?: string | null
          client_email?: string | null
          client_name?: string | null
          client_phone?: string | null
          contract_price?: number | null
          created_at?: string
          created_by?: string | null
          dashboard_pulled_at?: string | null
          dashboard_url?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          name?: string
          notes?: string | null
          project_number?: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          target_completion_date?: string | null
        }
        Relationships: [
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
        ]
      }
      schedule_assignments: {
        Row: {
          company_id: string | null
          created_at: string
          id: string
          notified_at: string | null
          profile_id: string | null
          schedule_item_id: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          id?: string
          notified_at?: string | null
          profile_id?: string | null
          schedule_item_id: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          id?: string
          notified_at?: string | null
          profile_id?: string | null
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
          reason_category: Database["public"]["Enums"]["delay_reason"]
          schedule_item_id: string
        }
        Insert: {
          delay_days: number
          id?: string
          logged_at?: string
          logged_by?: string | null
          notes?: string | null
          reason_category: Database["public"]["Enums"]["delay_reason"]
          schedule_item_id: string
        }
        Update: {
          delay_days?: number
          id?: string
          logged_at?: string
          logged_by?: string | null
          notes?: string | null
          reason_category?: Database["public"]["Enums"]["delay_reason"]
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
      schedule_items: {
        Row: {
          baseline_end_date: string | null
          baseline_start_date: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          duration_days: number | null
          end_date: string | null
          id: string
          kind: Database["public"]["Enums"]["schedule_item_kind"]
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
          title: string
          updated_at: string
        }
        Insert: {
          baseline_end_date?: string | null
          baseline_start_date?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          duration_days?: number | null
          end_date?: string | null
          id?: string
          kind: Database["public"]["Enums"]["schedule_item_kind"]
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
          title: string
          updated_at?: string
        }
        Update: {
          baseline_end_date?: string | null
          baseline_start_date?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          duration_days?: number | null
          end_date?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["schedule_item_kind"]
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
          title?: string
          updated_at?: string
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
          created_at: string
          id: string
          is_done: boolean
          label: string
          position: number
          schedule_item_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_done?: boolean
          label: string
          position?: number
          schedule_item_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_done?: boolean
          label?: string
          position?: number
          schedule_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "todo_checklist_items_schedule_item_id_fkey"
            columns: ["schedule_item_id"]
            isOneToOne: false
            referencedRelation: "schedule_items"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      client_decide_decision: {
        Args: { p_action: string; p_choice_id?: string; p_decision_id: string }
        Returns: Json
      }
      current_role_name: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      is_member_of_project: { Args: { p_project: string }; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      next_decision_number: { Args: { p_project: string }; Returns: number }
    }
    Enums: {
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
      file_category:
        | "house_plans"
        | "plot_plan"
        | "permit"
        | "contract"
        | "other"
      payment_method: "check" | "wire" | "card" | "cash" | "other"
      project_status:
        | "lead"
        | "pre_construction"
        | "active"
        | "on_hold"
        | "complete"
        | "cancelled"
      schedule_item_kind: "work" | "todo"
      schedule_item_status:
        | "not_started"
        | "in_progress"
        | "complete"
        | "delayed"
      schedule_parent_anchor: "start" | "end"
      todo_priority: "low" | "medium" | "high"
      user_role: "staff" | "trade" | "client"
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
      file_category: [
        "house_plans",
        "plot_plan",
        "permit",
        "contract",
        "other",
      ],
      payment_method: ["check", "wire", "card", "cash", "other"],
      project_status: [
        "lead",
        "pre_construction",
        "active",
        "on_hold",
        "complete",
        "cancelled",
      ],
      schedule_item_kind: ["work", "todo"],
      schedule_item_status: [
        "not_started",
        "in_progress",
        "complete",
        "delayed",
      ],
      schedule_parent_anchor: ["start", "end"],
      todo_priority: ["low", "medium", "high"],
      user_role: ["staff", "trade", "client"],
    },
  },
} as const
