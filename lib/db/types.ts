export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
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
        Relationships: []
      }
      profiles: {
        Row: {
          company_id: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          email: string
          full_name?: string
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
        }
        Update: {
          company_id?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
        }
        Relationships: []
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
        Relationships: []
      }
      projects: {
        Row: {
          address: string | null
          client_company_id: string | null
          contract_price: number | null
          created_at: string
          created_by: string | null
          dashboard_url: string | null
          id: string
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
          contract_price?: number | null
          created_at?: string
          created_by?: string | null
          dashboard_url?: string | null
          id?: string
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
          contract_price?: number | null
          created_at?: string
          created_by?: string | null
          dashboard_url?: string | null
          id?: string
          name?: string
          notes?: string | null
          project_number?: string
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          target_completion_date?: string | null
        }
        Relationships: []
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
        Relationships: []
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
        Relationships: []
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
          parent_id: string | null
          position: number
          project_id: string
          recurrence_parent_id: string | null
          recurrence_rule: Json | null
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
          parent_id?: string | null
          position?: number
          project_id: string
          recurrence_parent_id?: string | null
          recurrence_rule?: Json | null
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
          parent_id?: string | null
          position?: number
          project_id?: string
          recurrence_parent_id?: string | null
          recurrence_rule?: Json | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["schedule_item_status"]
          title?: string
          updated_at?: string
        }
        Relationships: []
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
        Relationships: []
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
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: {
      company_type: "sub" | "vendor" | "client"
      delay_reason:
        | "weather"
        | "sub"
        | "material"
        | "owner_decision"
        | "permit"
        | "other"
      dependency_type: "FS" | "SS" | "FF" | "SF"
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
      user_role: "staff" | "trade" | "client"
    }
    CompositeTypes: { [_ in never]: never }
  }
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"]
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"]
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T]
