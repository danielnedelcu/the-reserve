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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      appointment_services: {
        Row: {
          appointment_id: string
          duration_min: number
          id: string
          name_snapshot: string
          price_cents: number
          service_id: string
          sort_order: number
        }
        Insert: {
          appointment_id: string
          duration_min: number
          id?: string
          name_snapshot: string
          price_cents: number
          service_id: string
          sort_order?: number
        }
        Update: {
          appointment_id?: string
          duration_min?: number
          id?: string
          name_snapshot?: string
          price_cents?: number
          service_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "appointment_services_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          blocked_from: string
          blocked_until: string
          booked_by: string
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_id: string
          created_at: string
          ends_at: string
          id: string
          location_id: string
          notes: string | null
          organization_id: string
          resource_id: string | null
          staff_id: string
          starts_at: string
          status: string
          updated_at: string
        }
        Insert: {
          blocked_from: string
          blocked_until: string
          booked_by: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id: string
          created_at?: string
          ends_at: string
          id?: string
          location_id: string
          notes?: string | null
          organization_id: string
          resource_id?: string | null
          staff_id: string
          starts_at: string
          status?: string
          updated_at?: string
        }
        Update: {
          blocked_from?: string
          blocked_until?: string
          booked_by?: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string
          created_at?: string
          ends_at?: string
          id?: string
          location_id?: string
          notes?: string | null
          organization_id?: string
          resource_id?: string | null
          staff_id?: string
          starts_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "appointments_booked_by_fkey"
            columns: ["booked_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "resources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      ask_queries: {
        Row: {
          cache_read_tokens: number | null
          cache_write_tokens: number | null
          cost_micros: number | null
          created_at: string
          duration_ms: number | null
          error: string | null
          generated_sql: string | null
          id: string
          input_tokens: number | null
          model: string | null
          organization_id: string
          output_tokens: number | null
          preset_id: string | null
          question: string | null
          resolved_question: string | null
          row_count: number | null
          source: string
          staff_id: string
          thread_id: string | null
        }
        Insert: {
          cache_read_tokens?: number | null
          cache_write_tokens?: number | null
          cost_micros?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          generated_sql?: string | null
          id?: string
          input_tokens?: number | null
          model?: string | null
          organization_id: string
          output_tokens?: number | null
          preset_id?: string | null
          question?: string | null
          resolved_question?: string | null
          row_count?: number | null
          source: string
          staff_id: string
          thread_id?: string | null
        }
        Update: {
          cache_read_tokens?: number | null
          cache_write_tokens?: number | null
          cost_micros?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          generated_sql?: string | null
          id?: string
          input_tokens?: number | null
          model?: string | null
          organization_id?: string
          output_tokens?: number | null
          preset_id?: string | null
          question?: string | null
          resolved_question?: string | null
          row_count?: number | null
          source?: string
          staff_id?: string
          thread_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ask_queries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ask_queries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_staff_id: string | null
          actor_user_id: string | null
          detail: Json | null
          entity_id: string | null
          entity_type: string | null
          id: number
          occurred_at: string
        }
        Insert: {
          action: string
          actor_staff_id?: string | null
          actor_user_id?: string | null
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: never
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_staff_id?: string | null
          actor_user_id?: string | null
          detail?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: never
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_staff_id_fkey"
            columns: ["actor_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_exceptions: {
        Row: {
          created_at: string
          created_by: string
          ends_at: string
          id: string
          kind: string
          note: string | null
          staff_id: string
          starts_at: string
          status: string
        }
        Insert: {
          created_at?: string
          created_by: string
          ends_at: string
          id?: string
          kind: string
          note?: string | null
          staff_id: string
          starts_at: string
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          ends_at?: string
          id?: string
          kind?: string
          note?: string | null
          staff_id?: string
          starts_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_exceptions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_exceptions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      availability_rules: {
        Row: {
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          location_id: string
          staff_id: string
          start_time: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          created_at?: string
          day_of_week: number
          end_time: string
          id?: string
          location_id: string
          staff_id: string
          start_time: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          location_id?: string
          staff_id?: string
          start_time?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "availability_rules_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "availability_rules_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      card_consents: {
        Row: {
          captured_by: string
          client_id: string
          created_at: string
          id: string
          method: string
          organization_id: string
          policy_text: string
        }
        Insert: {
          captured_by: string
          client_id: string
          created_at?: string
          id?: string
          method?: string
          organization_id: string
          policy_text: string
        }
        Update: {
          captured_by?: string
          client_id?: string
          created_at?: string
          id?: string
          method?: string
          organization_id?: string
          policy_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_consents_captured_by_fkey"
            columns: ["captured_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_consents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_consents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_notes: {
        Row: {
          author_id: string
          body: string
          client_id: string
          created_at: string
          id: string
          kind: string
        }
        Insert: {
          author_id: string
          body: string
          client_id: string
          created_at?: string
          id?: string
          kind: string
        }
        Update: {
          author_id?: string
          body?: string
          client_id?: string
          created_at?: string
          id?: string
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_payment_methods: {
        Row: {
          active: boolean
          brand: string
          client_id: string
          consent_id: string
          created_at: string
          exp_month: number
          exp_year: number
          id: string
          last4: string
          organization_id: string
          stripe_payment_method_id: string
        }
        Insert: {
          active?: boolean
          brand: string
          client_id: string
          consent_id: string
          created_at?: string
          exp_month: number
          exp_year: number
          id?: string
          last4: string
          organization_id: string
          stripe_payment_method_id: string
        }
        Update: {
          active?: boolean
          brand?: string
          client_id?: string
          consent_id?: string
          created_at?: string
          exp_month?: number
          exp_year?: number
          id?: string
          last4?: string
          organization_id?: string
          stripe_payment_method_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_payment_methods_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_payment_methods_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "card_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_payment_methods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          active: boolean
          address_line1: string | null
          address_line2: string | null
          city: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          first_name: string
          flags: Json
          id: string
          last_name: string
          marketing_opt_in: boolean
          marketing_opt_in_at: string | null
          no_show_count: number
          organization_id: string
          phone: string | null
          postal_code: string | null
          preferred_contact_method: string
          preferred_staff_id: string | null
          pronouns: string | null
          referral_source: string | null
          state: string | null
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name: string
          flags?: Json
          id?: string
          last_name: string
          marketing_opt_in?: boolean
          marketing_opt_in_at?: string | null
          no_show_count?: number
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          preferred_contact_method?: string
          preferred_staff_id?: string | null
          pronouns?: string | null
          referral_source?: string | null
          state?: string | null
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          first_name?: string
          flags?: Json
          id?: string
          last_name?: string
          marketing_opt_in?: boolean
          marketing_opt_in_at?: string | null
          no_show_count?: number
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          preferred_contact_method?: string
          preferred_staff_id?: string | null
          pronouns?: string | null
          referral_source?: string | null
          state?: string | null
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_preferred_staff_id_fkey"
            columns: ["preferred_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_participants: {
        Row: {
          conversation_id: string
          joined_at: string
          last_read_at: string
          staff_id: string
        }
        Insert: {
          conversation_id: string
          joined_at?: string
          last_read_at?: string
          staff_id: string
        }
        Update: {
          conversation_id?: string
          joined_at?: string
          last_read_at?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_participants_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_participants_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          created_by: string
          id: string
          kind: string
          name: string | null
          organization_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          kind: string
          name?: string | null
          organization_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          kind?: string
          name?: string | null
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      gift_cards: {
        Row: {
          active: boolean
          balance_cents: number
          code: string
          created_at: string
          id: string
          initial_balance_cents: number
          organization_id: string
          purchaser_client_id: string | null
          recipient_email: string | null
          recipient_name: string | null
        }
        Insert: {
          active?: boolean
          balance_cents: number
          code: string
          created_at?: string
          id?: string
          initial_balance_cents: number
          organization_id: string
          purchaser_client_id?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
        }
        Update: {
          active?: boolean
          balance_cents?: number
          code?: string
          created_at?: string
          id?: string
          initial_balance_cents?: number
          organization_id?: string
          purchaser_client_id?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gift_cards_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_cards_purchaser_client_id_fkey"
            columns: ["purchaser_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          active: boolean
          address_line1: string | null
          address_line2: string | null
          business_hours: Json | null
          city: string | null
          created_at: string
          id: string
          name: string
          organization_id: string
          phone: string | null
          postal_code: string | null
          state: string | null
          tax_rate_bps: number
          timezone: string
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          business_hours?: Json | null
          city?: string | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tax_rate_bps?: number
          timezone: string
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          business_hours?: Json | null
          city?: string | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          state?: string | null
          tax_rate_bps?: number
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          body: string
          conversation_id: string
          created_at: string
          id: string
          sender_staff_id: string
        }
        Insert: {
          body: string
          conversation_id: string
          created_at?: string
          id?: string
          sender_staff_id: string
        }
        Update: {
          body?: string
          conversation_id?: string
          created_at?: string
          id?: string
          sender_staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_staff_id_fkey"
            columns: ["sender_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          kind: string
          link: string | null
          read_at: string | null
          staff_id: string
          title: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          kind: string
          link?: string | null
          read_at?: string | null
          staff_id: string
          title: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          link?: string | null
          read_at?: string | null
          staff_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          branding: Json
          created_at: string
          id: string
          name: string
          timezone: string
        }
        Insert: {
          branding?: Json
          created_at?: string
          id?: string
          name: string
          timezone?: string
        }
        Update: {
          branding?: Json
          created_at?: string
          id?: string
          name?: string
          timezone?: string
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          gift_card_id: string | null
          id: string
          method: string
          reference: string | null
          stripe_payment_intent_id: string | null
          transaction_id: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          gift_card_id?: string | null
          id?: string
          method: string
          reference?: string | null
          stripe_payment_intent_id?: string | null
          transaction_id: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          gift_card_id?: string | null
          id?: string
          method?: string
          reference?: string | null
          stripe_payment_intent_id?: string | null
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_gift_card_id_fkey"
            columns: ["gift_card_id"]
            isOneToOne: false
            referencedRelation: "gift_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          description: string
          key: string
        }
        Insert: {
          description: string
          key: string
        }
        Update: {
          description?: string
          key?: string
        }
        Relationships: []
      }
      products: {
        Row: {
          active: boolean
          cost_cents: number | null
          created_at: string
          description: string | null
          id: string
          name: string
          organization_id: string
          price_cents: number
          sku: string | null
          stock_quantity: number
          taxable: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          cost_cents?: number | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          organization_id: string
          price_cents: number
          sku?: string | null
          stock_quantity?: number
          taxable?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          cost_cents?: number | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          price_cents?: number
          sku?: string | null
          stock_quantity?: number
          taxable?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resource_types: {
        Row: {
          id: string
          name: string
          organization_id: string
        }
        Insert: {
          id?: string
          name: string
          organization_id: string
        }
        Update: {
          id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "resource_types_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      resources: {
        Row: {
          active: boolean
          created_at: string
          id: string
          location_id: string
          name: string
          resource_type_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          location_id: string
          name: string
          resource_type_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          location_id?: string
          name?: string
          resource_type_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "resources_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "resources_resource_type_id_fkey"
            columns: ["resource_type_id"]
            isOneToOne: false
            referencedRelation: "resource_types"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_key: string
          role_id: string
        }
        Insert: {
          permission_key: string
          role_id: string
        }
        Update: {
          permission_key?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_key_fkey"
            columns: ["permission_key"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          id: string
          is_system: boolean
          name: string
          organization_id: string
        }
        Insert: {
          id?: string
          is_system?: boolean
          name: string
          organization_id: string
        }
        Update: {
          id?: string
          is_system?: boolean
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      service_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "service_categories_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      service_resource_requirements: {
        Row: {
          resource_type_id: string
          service_id: string
        }
        Insert: {
          resource_type_id: string
          service_id: string
        }
        Update: {
          resource_type_id?: string
          service_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_resource_requirements_resource_type_id_fkey"
            columns: ["resource_type_id"]
            isOneToOne: false
            referencedRelation: "resource_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_resource_requirements_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      service_staff: {
        Row: {
          created_at: string
          duration_override_min: number | null
          price_override_cents: number | null
          service_id: string
          staff_id: string
        }
        Insert: {
          created_at?: string
          duration_override_min?: number | null
          price_override_cents?: number | null
          service_id: string
          staff_id: string
        }
        Update: {
          created_at?: string
          duration_override_min?: number | null
          price_override_cents?: number | null
          service_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_staff_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_staff_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          active: boolean
          buffer_after_min: number
          buffer_before_min: number
          category_id: string | null
          created_at: string
          description: string | null
          duration_minutes: number
          id: string
          name: string
          organization_id: string
          price_cents: number
          requires_intake: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          buffer_after_min?: number
          buffer_before_min?: number
          category_id?: string | null
          created_at?: string
          description?: string | null
          duration_minutes: number
          id?: string
          name: string
          organization_id: string
          price_cents: number
          requires_intake?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          buffer_after_min?: number
          buffer_before_min?: number
          category_id?: string | null
          created_at?: string
          description?: string | null
          duration_minutes?: number
          id?: string
          name?: string
          organization_id?: string
          price_cents?: number
          requires_intake?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "service_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          active: boolean
          address_line1: string | null
          address_line2: string | null
          avatar_url: string | null
          bookable: boolean
          city: string | null
          color: string | null
          created_at: string
          display_name: string
          email: string
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          hired_at: string | null
          id: string
          organization_id: string
          phone: string | null
          postal_code: string | null
          pronouns: string | null
          state: string | null
          title: string | null
          user_id: string | null
        }
        Insert: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bookable?: boolean
          city?: string | null
          color?: string | null
          created_at?: string
          display_name: string
          email: string
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          hired_at?: string | null
          id?: string
          organization_id: string
          phone?: string | null
          postal_code?: string | null
          pronouns?: string | null
          state?: string | null
          title?: string | null
          user_id?: string | null
        }
        Update: {
          active?: boolean
          address_line1?: string | null
          address_line2?: string | null
          avatar_url?: string | null
          bookable?: boolean
          city?: string | null
          color?: string | null
          created_at?: string
          display_name?: string
          email?: string
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          hired_at?: string | null
          id?: string
          organization_id?: string
          phone?: string | null
          postal_code?: string | null
          pronouns?: string | null
          state?: string | null
          title?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          display_name: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string
          location_ids: string[]
          organization_id: string
          revoked_at: string | null
          role_ids: string[]
          title: string | null
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          location_ids?: string[]
          organization_id: string
          revoked_at?: string | null
          role_ids: string[]
          title?: string | null
          token?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          location_ids?: string[]
          organization_id?: string
          revoked_at?: string | null
          role_ids?: string[]
          title?: string | null
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_locations: {
        Row: {
          location_id: string
          staff_id: string
        }
        Insert: {
          location_id: string
          staff_id: string
        }
        Update: {
          location_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_locations_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_roles: {
        Row: {
          role_id: string
          staff_id: string
        }
        Insert: {
          role_id: string
          staff_id: string
        }
        Update: {
          role_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_roles_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_roles_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          id: string
          processed_at: string
          type: string
        }
        Insert: {
          id: string
          processed_at?: string
          type: string
        }
        Update: {
          id?: string
          processed_at?: string
          type?: string
        }
        Relationships: []
      }
      transaction_items: {
        Row: {
          appointment_id: string | null
          discount_reason: string | null
          gift_card_id: string | null
          id: string
          kind: string
          name_snapshot: string
          product_id: string | null
          quantity: number
          staff_id: string | null
          tax_cents: number
          taxable: boolean
          total_cents: number
          transaction_id: string
          unit_price_cents: number
        }
        Insert: {
          appointment_id?: string | null
          discount_reason?: string | null
          gift_card_id?: string | null
          id?: string
          kind: string
          name_snapshot: string
          product_id?: string | null
          quantity?: number
          staff_id?: string | null
          tax_cents?: number
          taxable?: boolean
          total_cents: number
          transaction_id: string
          unit_price_cents: number
        }
        Update: {
          appointment_id?: string | null
          discount_reason?: string | null
          gift_card_id?: string | null
          id?: string
          kind?: string
          name_snapshot?: string
          product_id?: string | null
          quantity?: number
          staff_id?: string | null
          tax_cents?: number
          taxable?: boolean
          total_cents?: number
          transaction_id?: string
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "transaction_items_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_gift_card_id_fkey"
            columns: ["gift_card_id"]
            isOneToOne: false
            referencedRelation: "gift_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transaction_items_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          appointment_id: string | null
          checked_out_by: string
          client_id: string | null
          created_at: string
          discount_cents: number
          id: string
          location_id: string
          note: string | null
          organization_id: string
          refunds_transaction_id: string | null
          subtotal_cents: number
          tax_cents: number
          tip_cents: number
          total_cents: number
        }
        Insert: {
          appointment_id?: string | null
          checked_out_by: string
          client_id?: string | null
          created_at?: string
          discount_cents?: number
          id?: string
          location_id: string
          note?: string | null
          organization_id: string
          refunds_transaction_id?: string | null
          subtotal_cents: number
          tax_cents?: number
          tip_cents?: number
          total_cents: number
        }
        Update: {
          appointment_id?: string | null
          checked_out_by?: string
          client_id?: string | null
          created_at?: string
          discount_cents?: number
          id?: string
          location_id?: string
          note?: string | null
          organization_id?: string
          refunds_transaction_id?: string | null
          subtotal_cents?: number
          tax_cents?: number
          tip_cents?: number
          total_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "transactions_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_checked_out_by_fkey"
            columns: ["checked_out_by"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_refunds_transaction_id_fkey"
            columns: ["refunds_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_staff_invite: {
        Args: {
          final_display_name: string
          final_title?: string
          invite_token: string
          new_user_id: string
        }
        Returns: string
      }
      count_other_active_super_admins: {
        Args: { excluded_staff: string; org: string }
        Returns: number
      }
      create_group_conversation: {
        Args: { p_name: string; p_staff_ids: string[] }
        Returns: string
      }
      current_org_id: { Args: never; Returns: string }
      current_staff_id: { Args: never; Returns: string }
      find_or_create_dm: { Args: { p_other_staff_id: string }; Returns: string }
      get_my_permissions: { Args: never; Returns: string[] }
      has_permission: { Args: { perm: string }; Returns: boolean }
      is_conversation_participant: {
        Args: { p_conversation_id: string }
        Returns: boolean
      }
      leave_conversation: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      mark_conversation_read: {
        Args: { p_conversation_id: string }
        Returns: undefined
      }
      timemultirange: { Args: never; Returns: unknown }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
