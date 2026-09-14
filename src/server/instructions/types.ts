// ─── Operator Instruction Types ───
// Instructions are the dispatcher -> operator command channel (e.g. "Hold at
// Central Station for 75 seconds"). They are created by a dispatcher directly
// or by accepting a headway recommendation.

export type InstructionAction = 'HOLD'

export type InstructionStatus = 'SENT' | 'ACKNOWLEDGED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED'

export interface OperatorInstruction {
  id: string
  vehicleId: string
  tripId: string
  routeId: string
  action: InstructionAction
  controlPointStopId: string
  controlPointStopName: string
  holdSeconds: number
  /** Operator-facing text (shown in the operator app / dashboard). */
  message: string
  status: InstructionStatus
  source: 'dispatcher' | 'recommendation'
  createdAt: number // epoch ms
  acknowledgedAt: number | null
  completedAt: number | null
  cancelledAt: number | null
  expiresAt: number // epoch ms
}

export interface CreateInstructionInput {
  vehicleId: string
  tripId: string
  routeId: string
  action: InstructionAction
  controlPointStopId: string
  controlPointStopName: string
  holdSeconds: number
  message: string
  source: 'dispatcher' | 'recommendation'
}
