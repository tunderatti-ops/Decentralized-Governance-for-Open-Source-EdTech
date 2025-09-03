// tests/voting-mechanism.test.ts

import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Proposal {
  creator: string;
  description: string;
  startHeight: number;
  endHeight: number;
  quorumPercentage: number;
  yesVotes: number;
  noVotes: number;
  abstainVotes: number;
  totalVotes: number;
  status: string;
}

interface Vote {
  voteType: string;
  amount: number;
  delegate?: string;
}

interface Delegation {
  delegatee: string;
}

interface ContractState {
  owner: string;
  governanceTokenContract: string;
  paused: boolean;
  proposalCounter: number;
  activeProposalCount: number;
  proposals: Map<number, Proposal>;
  votes: Map<string, Vote>; // Key: `${proposalId}-${voter}`
  delegations: Map<string, Delegation>; // Key: delegator
  blockHeight: number; // Mocked block height
  tokenBalances: Map<string, number>; // Mocked balances for testing
  totalSupply: number;
}

// Mock contract implementation
class VotingMechanismMock {
  private state: ContractState = {
    owner: "deployer",
    governanceTokenContract: "SP000000000000000000002Q6VF78.governance-token",
    paused: false,
    proposalCounter: 0,
    activeProposalCount: 0,
    proposals: new Map(),
    votes: new Map(),
    delegations: new Map(),
    blockHeight: 1000,
    tokenBalances: new Map([["deployer", 1000000], ["voter1", 5000], ["voter2", 3000], ["voter3", 2000]]),
    totalSupply: 100000000,
  };

  private MIN_PROPOSAL_THRESHOLD = 1000;
  private MIN_VOTING_DURATION = 144;
  private MAX_VOTING_DURATION = 10080;
  private MAX_ACTIVE_PROPOSALS = 50;

  private ERR_UNAUTHORIZED = 100;
  private ERR_PROPOSAL_NOT_FOUND = 101;
  private ERR_PROPOSAL_NOT_ACTIVE = 102;
  private ERR_ALREADY_VOTED = 103;
  private ERR_INSUFFICIENT_BALANCE = 104;
  private ERR_VOTING_ENDED = 105;
  private ERR_QUORUM_NOT_MET = 106;
  private ERR_INVALID_VOTE_TYPE = 107;
  private ERR_PROPOSAL_THRESHOLD_NOT_MET = 108;
  private ERR_DELEGATION_NOT_ALLOWED = 109;
  private ERR_PAUSED = 110;
  private ERR_INVALID_DURATION = 111;
  private ERR_MAX_PROPOSALS_REACHED = 112;
  private ERR_INVALID_QUORUM = 113;

  // Helper to advance block height
  advanceBlockHeight(blocks: number) {
    this.state.blockHeight += blocks;
  }

  private getTokenBalance(account: string): ClarityResponse<number> {
    return { ok: true, value: this.state.tokenBalances.get(account) ?? 0 };
  }

  private getTotalSupply(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalSupply };
  }

  setGovernanceToken(caller: string, newToken: string): ClarityResponse<boolean> {
    if (caller !== this.state.owner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.governanceTokenContract = newToken;
    return { ok: true, value: true };
  }

  pause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.owner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.owner) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  createProposal(caller: string, description: string, votingDuration: number, quorumPercentage: number): ClarityResponse<number> {
    const balance = this.getTokenBalance(caller).value as number;
    const proposalId = this.state.proposalCounter + 1;
    const startHeight = this.state.blockHeight + 1;
    const endHeight = startHeight + votingDuration;

    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (this.state.activeProposalCount > this.MAX_ACTIVE_PROPOSALS) {
      return { ok: false, value: this.ERR_MAX_PROPOSALS_REACHED };
    }
    if (votingDuration < this.MIN_VOTING_DURATION || votingDuration > this.MAX_VOTING_DURATION) {
      return { ok: false, value: this.ERR_INVALID_DURATION };
    }
    if (quorumPercentage < 10 || quorumPercentage > 100) {
      return { ok: false, value: this.ERR_INVALID_QUORUM };
    }
    if (balance < this.MIN_PROPOSAL_THRESHOLD) {
      return { ok: false, value: this.ERR_PROPOSAL_THRESHOLD_NOT_MET };
    }

    this.state.proposals.set(proposalId, {
      creator: caller,
      description,
      startHeight,
      endHeight,
      quorumPercentage,
      yesVotes: 0,
      noVotes: 0,
      abstainVotes: 0,
      totalVotes: 0,
      status: "pending",
    });
    this.state.proposalCounter = proposalId;
    this.state.activeProposalCount += 1;
    return { ok: true, value: proposalId };
  }

  vote(caller: string, proposalId: number, voteType: string, amount: number): ClarityResponse<boolean> {
    const proposal = this.state.proposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    const balance = this.getTokenBalance(caller).value as number;
    const effectiveAmount = Math.min(amount, balance);
    const voteKey = `${proposalId}-${caller}`;
    const delegation = this.state.delegations.get(caller);
    const effectiveVoter = delegation ? delegation.delegatee : caller;

    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (this.state.blockHeight < proposal.startHeight || this.state.blockHeight > proposal.endHeight) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_ACTIVE };
    }
    if (this.state.votes.has(voteKey)) {
      return { ok: false, value: this.ERR_ALREADY_VOTED };
    }
    if (effectiveAmount < 1) {
      return { ok: false, value: this.ERR_INSUFFICIENT_BALANCE };
    }
    if (!["yes", "no", "abstain"].includes(voteType)) {
      return { ok: false, value: this.ERR_INVALID_VOTE_TYPE };
    }

    const newVoteKey = `${proposalId}-${effectiveVoter}`;
    this.state.votes.set(newVoteKey, {
      voteType,
      amount: effectiveAmount,
      delegate: delegation ? delegation.delegatee : undefined,
    });

    if (voteType === "yes") proposal.yesVotes += effectiveAmount;
    if (voteType === "no") proposal.noVotes += effectiveAmount;
    if (voteType === "abstain") proposal.abstainVotes += effectiveAmount;
    proposal.totalVotes += effectiveAmount;
    proposal.status = this.state.blockHeight >= proposal.startHeight ? "active" : proposal.status;

    this.state.proposals.set(proposalId, proposal);
    return { ok: true, value: true };
  }

  delegateVote(caller: string, delegatee: string): ClarityResponse<boolean> {
    if (caller === delegatee) {
      return { ok: false, value: this.ERR_DELEGATION_NOT_ALLOWED };
    }
    this.state.delegations.set(caller, { delegatee });
    return { ok: true, value: true };
  }

  revokeDelegation(caller: string): ClarityResponse<boolean> {
    this.state.delegations.delete(caller);
    return { ok: true, value: true };
  }

  finalizeProposal(caller: string, proposalId: number): ClarityResponse<string> {
    const proposal = this.state.proposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    const totalSupply = this.getTotalSupply().value as number;
    const requiredQuorum = Math.floor((totalSupply * proposal.quorumPercentage) / 100);

    if (this.state.blockHeight <= proposal.endHeight) {
      return { ok: false, value: this.ERR_VOTING_ENDED };
    }
    if (proposal.status !== "active") {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_ACTIVE };
    }

    if (proposal.totalVotes < requiredQuorum) {
      proposal.status = "rejected";
      this.state.proposals.set(proposalId, proposal);
      this.state.activeProposalCount -= 1;
      return { ok: true, value: "rejected" };
    }

    const passed = proposal.yesVotes > proposal.noVotes;
    proposal.status = passed ? "passed" : "rejected";
    this.state.proposals.set(proposalId, proposal);
    this.state.activeProposalCount -= 1;
    return { ok: true, value: passed ? "passed" : "rejected" };
  }

  cancelProposal(caller: string, proposalId: number): ClarityResponse<boolean> {
    const proposal = this.state.proposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    if (proposal.creator !== caller) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (!["pending", "active"].includes(proposal.status)) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_ACTIVE };
    }

    proposal.status = "cancelled";
    this.state.proposals.set(proposalId, proposal);
    if (proposal.status === "active") {
      this.state.activeProposalCount -= 1;
    }
    return { ok: true, value: true };
  }

  getProposal(proposalId: number): ClarityResponse<Proposal | null> {
    return { ok: true, value: this.state.proposals.get(proposalId) ?? null };
  }

  getVote(proposalId: number, voter: string): ClarityResponse<Vote | null> {
    const voteKey = `${proposalId}-${voter}`;
    return { ok: true, value: this.state.votes.get(voteKey) ?? null };
  }

  getDelegation(delegator: string): ClarityResponse<Delegation | null> {
    return { ok: true, value: this.state.delegations.get(delegator) ?? null };
  }

  getProposalCount(): ClarityResponse<number> {
    return { ok: true, value: this.state.proposalCounter };
  }

  isContractPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  voter1: "voter1",
  voter2: "voter2",
  voter3: "voter3",
};

describe("VotingMechanism Contract", () => {
  let contract: VotingMechanismMock;

  beforeEach(() => {
    contract = new VotingMechanismMock();
    vi.resetAllMocks();
  });

  it("should allow owner to pause and unpause the contract", () => {
    const pauseResult = contract.pause(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: true });

    const createDuringPause = contract.createProposal(accounts.deployer, "Test proposal", 144, 20);
    expect(createDuringPause).toEqual({ ok: false, value: 110 });

    const unpauseResult = contract.unpause(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.isContractPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-owner from pausing", () => {
    const pauseResult = contract.pause(accounts.voter1);
    expect(pauseResult).toEqual({ ok: false, value: 100 });
  });

  it("should create a proposal with valid parameters", () => {
    const createResult = contract.createProposal(accounts.deployer, "Add new feature", 144, 20);
    expect(createResult).toEqual({ ok: true, value: 1 });

    const proposal = contract.getProposal(1).value as Proposal;
    expect(proposal).toMatchObject({
      creator: accounts.deployer,
      description: "Add new feature",
      quorumPercentage: 20,
      yesVotes: 0,
      noVotes: 0,
      abstainVotes: 0,
      totalVotes: 0,
      status: "pending",
    });
    expect(contract.getProposalCount()).toEqual({ ok: true, value: 1 });
  });

  it("should prevent proposal creation below threshold", () => {
    const lowBalanceAccount = "lowBalance";
    contract.state.tokenBalances.set(lowBalanceAccount, 500); // Below 1000
    const createResult = contract.createProposal(lowBalanceAccount, "Invalid proposal", 144, 20);
    expect(createResult).toEqual({ ok: false, value: 108 });
  });

  it("should allow voting on active proposal", () => {
    contract.createProposal(accounts.deployer, "Test proposal", 144, 20);
    contract.advanceBlockHeight(1); // Make it active

    const voteResult = contract.vote(accounts.voter1, 1, "yes", 5000);
    expect(voteResult).toEqual({ ok: true, value: true });

    const vote = contract.getVote(1, accounts.voter1).value as Vote;
    expect(vote).toEqual({ voteType: "yes", amount: 5000 });

    const proposal = contract.getProposal(1).value as Proposal;
    expect(proposal.yesVotes).toBe(5000);
    expect(proposal.totalVotes).toBe(5000);
    expect(proposal.status).toBe("active");
  });

  it("should handle delegated voting", () => {
    contract.createProposal(accounts.deployer, "Test proposal", 144, 20);
    contract.advanceBlockHeight(1);

    const delegateResult = contract.delegateVote(accounts.voter2, accounts.voter1);
    expect(delegateResult).toEqual({ ok: true, value: true });

    const voteResult = contract.vote(accounts.voter2, 1, "no", 3000);
    expect(voteResult).toEqual({ ok: true, value: true });

    const vote = contract.getVote(1, accounts.voter1).value as Vote;
    expect(vote).toEqual({ voteType: "no", amount: 3000, delegate: accounts.voter1 });
  });

  it("should prevent double voting", () => {
    contract.createProposal(accounts.deployer, "Test proposal", 144, 20);
    contract.advanceBlockHeight(1);

    contract.vote(accounts.voter1, 1, "yes", 5000);
    const secondVote = contract.vote(accounts.voter1, 1, "no", 5000);
    expect(secondVote).toEqual({ ok: false, value: 103 });
  });

  it("should allow creator to cancel pending proposal", () => {
    contract.createProposal(accounts.deployer, "To cancel", 144, 20);

    const cancelResult = contract.cancelProposal(accounts.deployer, 1);
    expect(cancelResult).toEqual({ ok: true, value: true });

    const proposal = contract.getProposal(1).value as Proposal;
    expect(proposal.status).toBe("cancelled");
  });

  it("should prevent non-creator from cancelling", () => {
    contract.createProposal(accounts.deployer, "No cancel", 144, 20);

    const cancelResult = contract.cancelProposal(accounts.voter1, 1);
    expect(cancelResult).toEqual({ ok: false, value: 100 });
  });
});