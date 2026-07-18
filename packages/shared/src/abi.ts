/**
 * The registry ABI, hand-written rather than generated from forge's artifacts.
 *
 * Only the surface the workers and the frontend actually call is here — the full
 * ERC-721 ABI would bloat the resolver's bundle for functions it never touches.
 * If you add a contract function that off-chain code calls, add it here too;
 * there is no codegen step that will do it for you.
 *
 * `as const` is load-bearing: viem derives its argument and return types from it.
 */
export const REGISTRY_ABI = [
  // --- reads -----------------------------------------------------------------
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [
      { name: 'cid', type: 'string' },
      { name: 'contentType', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'frozen', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'available',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'priceOf',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenIdOf',
    stateMutability: 'pure',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nameOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'updateFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalRegistered',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },

  // --- writes ----------------------------------------------------------------
  {
    type: 'function',
    name: 'register',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'cid', type: 'string' },
      { name: 'contentType', type: 'string' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setCid',
    stateMutability: 'payable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'cid', type: 'string' },
      { name: 'contentType', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'freeze',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'transferFrom',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [],
  },

  // --- events ----------------------------------------------------------------
  // The indexer subscribes to these. Transfer is included because a secondary
  // sale changes a name's owner without touching any registry-specific event —
  // without it, `o:<address>` goes stale the moment a name sells on OpenSea.
  {
    type: 'event',
    name: 'NameRegistered',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'name', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'cid', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CidUpdated',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'cid', type: 'string', indexed: false },
      { name: 'contentType', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RecordFrozen',
    inputs: [{ name: 'tokenId', type: 'uint256', indexed: true }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'id', type: 'uint256', indexed: true },
    ],
  },
] as const;
