export type RelayConnectionState = 'stopped' | 'connecting' | 'connected' | 'error' | 'replaced'

/** Public Relay control-plane status; secrets are deliberately absent. */
export interface RelayStatus {
  configured: boolean
  enabled: boolean
  serverUrl: string | null
  e2eEncryption: boolean
  deviceName: string
  state: RelayConnectionState
  lastError: string | null
  connectedAt: number | null
  activeTunnels: number
}
