;; voting-mechanism.clar
;;
;; Core voting mechanism for decentralized governance in open-source EdTech.
;; This contract handles the creation, voting, and finalization of proposals
;; for EdTech project updates, using weighted voting based on governance tokens.
;; It integrates with a SIP-010 compliant GovernanceToken contract for balance checks.
;; Features include time-locked voting, quorum requirements, vote delegation,
;; proposal thresholds, and event emissions for transparency.
;; Assumes proposal IDs are unique and managed sequentially.

;; Traits
(define-trait governance-token-trait 
  (
    ;; Get balance for an account
    (get-balance (principal) (response uint uint))
    ;; Transfer tokens between accounts
    (transfer (uint principal principal (optional (buff 34))) (response bool uint))
    ;; Get total supply
    (get-total-supply () (response uint uint))
  )
)

;; Constants
(define-constant ERR-UNAUTHORIZED (err u100))
(define-constant ERR-PROPOSAL-NOT-FOUND (err u101))
(define-constant ERR-PROPOSAL-NOT-ACTIVE (err u102))
(define-constant ERR-ALREADY-VOTED (err u103))
(define-constant ERR-INSUFFICIENT-BALANCE (err u104))
(define-constant ERR-VOTING-ENDED (err u105))
(define-constant ERR-QUORUM-NOT-MET (err u106))
(define-constant ERR-INVALID-VOTE-TYPE (err u107))
(define-constant ERR-PROPOSAL-THRESHOLD-NOT-MET (err u108))
(define-constant ERR-DELEGATION-NOT-ALLOWED (err u109))
(define-constant ERR-PAUSED (err u110))
(define-constant ERR-INVALID-DURATION (err u111))
(define-constant ERR-MAX-PROPOSALS-REACHED (err u112))
(define-constant ERR-INVALID-QUORUM (err u113))

(define-constant VOTE-YES "yes")
(define-constant VOTE-NO "no")
(define-constant VOTE-ABSTAIN "abstain")

(define-constant STATUS-PENDING "pending")
(define-constant STATUS-ACTIVE "active")
(define-constant STATUS-PASSED "passed")
(define-constant STATUS-REJECTED "rejected")
(define-constant STATUS-EXECUTED "executed")
(define-constant STATUS-CANCELLED "cancelled")

(define-constant MIN-PROPOSAL-THRESHOLD u1000) ;; Min tokens to create proposal
(define-constant MIN_VOTING_DURATION u144) ;; ~1 day in blocks
(define-constant MAX_VOTING_DURATION u10080) ;; ~1 week
(define-constant MAX_ACTIVE_PROPOSALS u50)

;; Data Variables
(define-data-var contract-owner principal tx-sender)
(define-data-var governance-token-contract principal 'SP000000000000000000002Q6VF78.governance-token) ;; Placeholder
(define-data-var paused bool false)
(define-data-var proposal-counter uint u0)
(define-data-var active-proposal-count uint u0)

;; Data Maps
(define-map proposals
  { proposal-id: uint }
  {
    creator: principal,
    description: (string-utf8 500),
    start-height: uint,
    end-height: uint,
    quorum-percentage: uint, ;; 0-100
    yes-votes: uint,
    no-votes: uint,
    abstain-votes: uint,
    total-votes: uint,
    status: (string-ascii 32)
  }
)

(define-map votes
  { proposal-id: uint, voter: principal }
  {
    vote-type: (string-ascii 32),
    amount: uint,
    delegate: (optional principal)
  }
)

(define-map delegations
  { delegator: principal }
  { delegatee: principal }
)

;; Private Functions
(define-private (is-owner (caller principal))
  (is-eq caller (var-get contract-owner))
)

(define-private (get-token-balance (account principal))
  (contract-call? .governance-token-trait get-balance account)
  ;; Note: In real deployment, use the trait with (contract-call? governance-token-contract get-balance account)
)

(define-private (emit-event (event-type (string-ascii 32)) (data (tuple (proposal-id uint) (optional (tuple (voter principal) (amount uint))))))
  (print { event: event-type, data: data })
)

;; Public Functions
(define-public (set-governance-token (new-token principal))
  (if (is-owner tx-sender)
    (ok (var-set governance-token-contract new-token))
    ERR-UNAUTHORIZED
  )
)

(define-public (pause)
  (if (is-owner tx-sender)
    (ok (var-set paused true))
    ERR-UNAUTHORIZED
  )
)

(define-public (unpause)
  (if (is-owner tx-sender)
    (ok (var-set paused false))
    ERR-UNAUTHORIZED
  )
)

(define-public (create-proposal (description (string-utf8 500)) (voting-duration uint) (quorum-percentage uint))
  (let
    (
      (creator tx-sender)
      (current-balance (unwrap! (get-token-balance creator) ERR-UNAUTHORIZED))
      (proposal-id (+ (var-get proposal-counter) u1))
      (start-height (+ block-height u1)) ;; Starts next block
      (end-height (+ start-height voting-duration))
    )
    (if (var-get paused) (err ERR-PAUSED) 
      (if (> (var-get active-proposal-count) MAX_ACTIVE_PROPOSALS) (err ERR-MAX-PROPOSALS-REACHED)
        (if (or (< voting-duration MIN_VOTING_DURATION) (> voting-duration MAX_VOTING_DURATION)) (err ERR-INVALID-DURATION)
          (if (or (< quorum-percentage u10) (> quorum-percentage u100)) (err ERR-INVALID-QUORUM)
            (if (< current-balance MIN-PROPOSAL-THRESHOLD) (err ERR-PROPOSAL-THRESHOLD-NOT-MET)
              (begin
                (map-set proposals {proposal-id: proposal-id}
                  {
                    creator: creator,
                    description: description,
                    start-height: start-height,
                    end-height: end-height,
                    quorum-percentage: quorum-percentage,
                    yes-votes: u0,
                    no-votes: u0,
                    abstain-votes: u0,
                    total-votes: u0,
                    status: STATUS-PENDING
                  }
                )
                (var-set proposal-counter proposal-id)
                (var-set active-proposal-count (+ (var-get active-proposal-count) u1))
                (emit-event "proposal-created" {proposal-id: proposal-id, voter: none})
                (ok proposal-id)
              )
            )
          )
        )
      )
    )
  )
)

(define-public (vote (proposal-id uint) (vote-type (string-ascii 32)) (amount uint))
  (let
    (
      (voter tx-sender)
      (proposal (unwrap! (map-get? proposals {proposal-id: proposal-id}) ERR-PROPOSAL-NOT-FOUND))
      (current-height block-height)
      (balance (unwrap! (get-token-balance voter) ERR-UNAUTHORIZED))
      (effective-amount (if (> amount balance) balance amount)) ;; Cap at balance
      (delegate (map-get? delegations {delegator: voter}))
    )
    (if (var-get paused) (err ERR-PAUSED)
      (if (or (< current-height (get start-height proposal)) (> current-height (get end-height proposal))) (err ERR-PROPOSAL-NOT-ACTIVE)
        (if (is-some (map-get? votes {proposal-id: proposal-id, voter: voter})) (err ERR-ALREADY-VOTED)
          (if (< effective-amount u1) (err ERR-INSUFFICIENT-BALANCE)
            (if (or (is-eq vote-type VOTE-YES) (is-eq vote-type VOTE-NO) (is-eq vote-type VOTE-ABSTAIN)) 
              (begin
                ;; Handle delegation if present
                (let ((effective-voter (match delegate d d voter)))
                  (map-set votes {proposal-id: proposal-id, voter: effective-voter}
                    {vote-type: vote-type, amount: effective-amount, delegate: delegate}
                  )
                  (map-set proposals {proposal-id: proposal-id}
                    (merge proposal 
                      {
                        yes-votes: (if (is-eq vote-type VOTE-YES) (+ (get yes-votes proposal) effective-amount) (get yes-votes proposal)),
                        no-votes: (if (is-eq vote-type VOTE-NO) (+ (get no-votes proposal) effective-amount) (get no-votes proposal)),
                        abstain-votes: (if (is-eq vote-type VOTE-ABSTAIN) (+ (get abstain-votes proposal) effective-amount) (get abstain-votes proposal)),
                        total-votes: (+ (get total-votes proposal) effective-amount),
                        status: (if (>= current-height (get start-height proposal)) STATUS-ACTIVE (get status proposal))
                      }
                    )
                  )
                  (emit-event "vote-cast" {proposal-id: proposal-id, voter: (some {voter: effective-voter, amount: effective-amount})})
                  (ok true)
                )
              )
              ERR-INVALID-VOTE-TYPE
            )
          )
        )
      )
    )
  )
)

(define-public (delegate-vote (delegatee principal))
  (if (is-eq tx-sender delegatee) (err ERR-DELEGATION-NOT-ALLOWED)
    (begin
      (map-set delegations {delegator: tx-sender} {delegatee: delegatee})
      (ok true)
    )
  )
)

(define-public (revoke-delegation)
  (begin
    (map-delete delegations {delegator: tx-sender})
    (ok true)
  )
)

(define-public (finalize-proposal (proposal-id uint))
  (let
    (
      (proposal (unwrap! (map-get? proposals {proposal-id: proposal-id}) ERR-PROPOSAL-NOT-FOUND))
      (current-height block-height)
      (total-supply (unwrap! (get-total-supply) ERR-UNAUTHORIZED)) ;; Assume get-total-supply in token trait
      (required-quorum (/ (* total-supply (get quorum-percentage proposal)) u100))
    )
    (if (<= current-height (get end-height proposal)) (err ERR-VOTING-ENDED)
      (if (not (is-eq (get status proposal) STATUS-ACTIVE)) (err ERR-PROPOSAL-NOT-ACTIVE)
        (if (< (get total-votes proposal) required-quorum) 
          (begin
            (map-set proposals {proposal-id: proposal-id} (merge proposal {status: STATUS-REJECTED}))
            (var-set active-proposal-count (- (var-get active-proposal-count) u1))
            (emit-event "proposal-rejected" {proposal-id: proposal-id, voter: none})
            (ok STATUS-REJECTED)
          )
          (let ((passed (> (get yes-votes proposal) (get no-votes proposal))))
            (map-set proposals {proposal-id: proposal-id} (merge proposal {status: (if passed STATUS-PASSED STATUS-REJECTED)}))
            (var-set active-proposal-count (- (var-get active-proposal-count) u1))
            (emit-event (if passed "proposal-passed" "proposal-rejected") {proposal-id: proposal-id, voter: none})
            (ok (if passed STATUS-PASSED STATUS-REJECTED))
          )
        )
      )
    )
  )
)

(define-public (cancel-proposal (proposal-id uint))
  (let
    (
      (proposal (unwrap! (map-get? proposals {proposal-id: proposal-id}) ERR-PROPOSAL-NOT-FOUND))
    )
    (if (not (is-eq (get creator proposal) tx-sender)) ERR-UNAUTHORIZED
      (if (or (is-eq (get status proposal) STATUS-ACTIVE) (is-eq (get status proposal) STATUS-PENDING))
        (begin
          (map-set proposals {proposal-id: proposal-id} (merge proposal {status: STATUS-CANCELLED}))
          (if (is-eq (get status proposal) STATUS-ACTIVE) (var-set active-proposal-count (- (var-get active-proposal-count) u1)) ok)
          (emit-event "proposal-cancelled" {proposal-id: proposal-id, voter: none})
          (ok true)
        )
        ERR-PROPOSAL-NOT-ACTIVE
      )
    )
  )
)

;; Read-Only Functions
(define-read-only (get-proposal (proposal-id uint))
  (map-get? proposals {proposal-id: proposal-id})
)

(define-read-only (get-vote (proposal-id uint) (voter principal))
  (map-get? votes {proposal-id: proposal-id, voter: voter})
)

(define-read-only (get-delegation (delegator principal))
  (map-get? delegations {delegator: delegator})
)

(define-read-only (get-proposal-count)
  (var-get proposal-counter)
)

(define-read-only (is-contract-paused)
  (var-get paused)
)

;; Assume this is implemented in the token contract, but for completeness
(define-read-only (get-total-supply)
  (ok u100000000) ;; Placeholder, in real: (contract-call? governance-token-contract get-total-supply)
)