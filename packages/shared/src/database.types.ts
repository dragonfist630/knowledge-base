export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      ai_usage_events: {
        Row: {
          completion_tokens: number
          conversation_id: string | null
          created_at: string
          document_id: string | null
          id: string
          is_estimated: boolean
          latency_ms: number | null
          model: string
          operation: string
          prompt_tokens: number
          provider: string
          total_tokens: number
          user_id: string
        }
        Insert: {
          completion_tokens?: number
          conversation_id?: string | null
          created_at?: string
          document_id?: string | null
          id?: string
          is_estimated?: boolean
          latency_ms?: number | null
          model: string
          operation: string
          prompt_tokens?: number
          provider: string
          total_tokens?: number
          user_id?: string
        }
        Update: {
          completion_tokens?: number
          conversation_id?: string | null
          created_at?: string
          document_id?: string | null
          id?: string
          is_estimated?: boolean
          latency_ms?: number | null
          model?: string
          operation?: string
          prompt_tokens?: number
          provider?: string
          total_tokens?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_usage_events_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      document_chunks: {
        Row: {
          char_end: number
          char_start: number
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string
          embedding_model: string
          fts: unknown
          heading_path: string | null
          id: string
          token_count: number
          user_id: string
        }
        Insert: {
          char_end: number
          char_start: number
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding: string
          embedding_model: string
          fts?: never
          heading_path?: string | null
          id?: string
          token_count: number
          user_id?: string
        }
        Update: {
          char_end?: number
          char_start?: number
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string
          embedding_model?: string
          fts?: never
          heading_path?: string | null
          id?: string
          token_count?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          chunk_count: number
          content: string
          content_hash: string
          created_at: string
          id: string
          index_error: string | null
          index_status: Database["public"]["Enums"]["index_status"]
          indexed_at: string | null
          source_name: string | null
          source_type: string
          tags: string[]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chunk_count?: number
          content?: string
          content_hash: string
          created_at?: string
          id?: string
          index_error?: string | null
          index_status?: Database["public"]["Enums"]["index_status"]
          indexed_at?: string | null
          source_name?: string | null
          source_type?: string
          tags?: string[]
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          chunk_count?: number
          content?: string
          content_hash?: string
          created_at?: string
          id?: string
          index_error?: string | null
          index_status?: Database["public"]["Enums"]["index_status"]
          indexed_at?: string | null
          source_name?: string | null
          source_type?: string
          tags?: string[]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          citations: NonNullable<Json>
          content: string
          conversation_id: string
          created_at: string
          id: string
          model: string | null
          retrieval: Json | null
          role: string
          status: string
          user_id: string
        }
        Insert: {
          citations?: NonNullable<Json>
          content?: string
          conversation_id: string
          created_at?: string
          id?: string
          model?: string | null
          retrieval?: Json | null
          role: string
          status?: string
          user_id?: string
        }
        Update: {
          citations?: NonNullable<Json>
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          model?: string | null
          retrieval?: Json | null
          role?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_document_chunks: {
        Args: {
          filter_document_ids?: string[]
          filter_tags?: string[]
          match_count?: number
          min_similarity?: number
          query_embedding: string
          query_text: string
        }
        Returns: {
          char_end: number
          char_start: number
          chunk_id: string
          chunk_index: number
          content: string
          document_id: string
          document_title: string
          heading_path: string
          score: number
          similarity: number
          text_rank: number
        }[]
      }
      replace_document_chunks: {
        Args: {
          p_chunks: Json
          p_content_hash: string
          p_document_id: string
          p_embedding_model: string
        }
        Returns: boolean
      }
      usage_summary: {
        Args: { p_from: string }
        Returns: {
          completion_tokens: number
          day: string
          event_count: number
          model: string
          operation: string
          prompt_tokens: number
          total_tokens: number
        }[]
      }
    }
    Enums: {
      index_status: "pending" | "indexing" | "ready" | "failed"
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
  public: {
    Enums: {
      index_status: ["pending", "indexing", "ready", "failed"],
    },
  },
} as const
