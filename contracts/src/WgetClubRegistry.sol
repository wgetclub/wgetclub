// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "solmate/tokens/ERC721.sol";
import {Owned} from "solmate/auth/Owned.sol";

/// @title WgetClubRegistry
/// @notice Names on wget.club, as ERC-721. Each name points at an IPFS CID.
///         `wget wget.club/<name>` resolves through this contract.
/// @dev    Ownership is PERMANENT — there is no expiry, no renewal, no reclaim.
///         The contract owner cannot take a name back. That is the whole point:
///         the name is the user's asset. The owner can only tune prices and
///         release reserved names. See docs/SPEC.md §3.
contract WgetClubRegistry is ERC721, Owned {
    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct Record {
        string cid;         // IPFS CID (v1 base32 or v0 base58)
        string contentType; // e.g. "text/plain; charset=utf-8"
        uint64 updatedAt;
        bool frozen;        // irreversible; see freeze()
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    mapping(uint256 => Record) private _records;
    /// @notice tokenId => the original name string. Enables reverse lookup.
    mapping(uint256 => string) public nameOf;
    /// @notice Names withheld from minting (system routes). Owner may release, never add.
    mapping(uint256 => bool) public reserved;

    /// @notice Price in wei by name length. Index = length, capped at MAX_LENGTH.
    ///         Lengths above the table's last set entry fall through to _tailPrice.
    mapping(uint256 => uint256) public priceByLength;
    uint256 public tailPrice = 0.0005 ether;
    uint256 public updateFee = 0.0001 ether;

    uint256 public totalRegistered;

    /// @dev ERC-2981 royalty: 5% to the treasury on secondary sales.
    address public royaltyReceiver;
    uint96 public constant ROYALTY_BPS = 500;

    uint256 public constant MIN_LENGTH = 2;
    uint256 public constant MAX_LENGTH = 64;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event NameRegistered(uint256 indexed tokenId, string name, address indexed owner, string cid);
    event CidUpdated(uint256 indexed tokenId, string cid, string contentType);
    event RecordFrozen(uint256 indexed tokenId);
    event PriceChanged(uint256 indexed length, uint256 wei_);
    event UpdateFeeChanged(uint256 wei_);
    event Unreserved(string name);
    event Withdrawn(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NameTooShort();
    error NameTooLong();
    error InvalidCharacter(bytes1 c);
    error MustStartAlphanumeric();
    error MustEndAlphanumeric();
    error ConsecutiveSeparators();
    error NameReserved();
    error NameTaken();
    error EmptyCid();
    error CidTooLong();
    error Underpaid(uint256 required, uint256 sent);
    error NotNameOwner();
    error RecordIsFrozen();
    error NothingToWithdraw();
    error WithdrawFailed();
    error NotReserved();
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    /// @dev Rejects a zero owner or royaltyReceiver, and this is not ceremony.
    ///
    ///      solmate's Owned takes address(0) without complaint. A registry with
    ///      owner == 0 has an unreachable withdraw(): ALL revenue is stuck in the
    ///      contract, forever, along with setPrice, setUpdateFee, unreserve and
    ///      setRoyaltyReceiver. There is no recovery — the contract is immutable and
    ///      the names people bought live inside it.
    ///
    ///      This nearly happened: a .env freshly copied from .env.example carries
    ///      REGISTRY_OWNER=0x000...0, and nothing between it and the chain looked at
    ///      the value. An RPC error is what stopped the deploy. Do not rely on luck
    ///      twice.
    ///
    ///      A zero royaltyReceiver is cheaper (setRoyaltyReceiver can fix it) but it
    ///      burns royalties until someone notices — and whoever gets one wrong gets
    ///      the other wrong too: they come from the same file.
    constructor(address owner_, address royaltyReceiver_)
        ERC721("wget.club", "WGET")
        Owned(owner_)
    {
        if (owner_ == address(0)) revert ZeroAddress();
        if (royaltyReceiver_ == address(0)) revert ZeroAddress();

        royaltyReceiver = royaltyReceiver_;

        priceByLength[2] = 0.05 ether;
        priceByLength[3] = 0.02 ether;
        priceByLength[4] = 0.005 ether;
        for (uint256 i = 5; i <= 9; i++) {
            priceByLength[i] = 0.001 ether;
        }
        // 10..64 falls through to tailPrice.

        _reserveDefaults();
    }

    /// @dev THE ONLY CHANCE to reserve anything. There is no reserve() — only
    ///      unreserve() — so this list can shrink forever after but never grow.
    ///      A name left out here is buyable by anyone, permanently.
    ///
    ///      Not hypothetical: `abuse` was missing while preview.ts rendered
    ///      `<a href="/abuse">denunciar abuso</a>` on every page and the 451 body
    ///      told blocked users to appeal at wget.club/abuse. Anyone could have bought
    ///      the channel their own victims would use to report them, for 0.001 ETH.
    ///
    ///      Before deploying: grep the product for every path it links to and reserve
    ///      it. Reserving costs one SSTORE. Not reserving costs the name, forever.
    ///      contracts/test/NameParity.t.sol proves this list matches the TS one.
    function _reserveDefaults() private {
        string[37] memory names = [
            // system routes / web conventions
            "api", "admin", "www", "app", "assets", "static", "cdn", "ipfs", "ipns",
            "health", "status", "_health", "favicon.ico", "robots.txt", "sitemap.xml",
            ".well-known", "index.html", "wget", "club",
            // institutional pages the product links to, or will link to
            "abuse", "terms", "tos", "privacy", "legal", "dmca", "security",
            "docs", "blog", "support", "help", "about", "contact", "pricing",
            // app routes
            "dashboard", "login", "account", "settings"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            reserved[tokenIdOf(names[i])] = true;
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Deterministic token id. Lets the frontend check availability with
    ///         no indexer and no subgraph — just an eth_call.
    function tokenIdOf(string memory name) public pure returns (uint256) {
        return uint256(keccak256(bytes(name)));
    }

    /// @notice True if `name` is valid, unreserved, and unminted.
    function available(string calldata name) external view returns (bool) {
        if (!_isValid(name)) return false;
        uint256 id = tokenIdOf(name);
        if (reserved[id]) return false;
        return _ownerOf[id] == address(0);
    }

    /// @notice Price to register `name`. Reverts if the name could never be minted,
    ///         so the frontend gets a reason rather than a meaningless number.
    function priceOf(string calldata name) public view returns (uint256) {
        _validate(name); // reverts with the specific reason
        if (reserved[tokenIdOf(name)]) revert NameReserved();
        return _priceForLength(bytes(name).length);
    }

    /// @notice One-call resolution. This is what the resolver Worker hits on a cache miss.
    function resolve(string calldata name)
        external
        view
        returns (string memory cid, string memory contentType, address owner_, bool frozen)
    {
        uint256 id = tokenIdOf(name);
        Record storage r = _records[id];
        return (r.cid, r.contentType, _ownerOf[id], r.frozen);
    }

    function recordOf(uint256 tokenId) external view returns (Record memory) {
        return _records[tokenId];
    }

    function _priceForLength(uint256 len) internal view returns (uint256) {
        uint256 p = priceByLength[len];
        return p == 0 ? tailPrice : p;
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    /// @notice Mint `name` to msg.sender and point it at `cid`.
    function register(string calldata name, string calldata cid, string calldata contentType)
        external
        payable
        returns (uint256 tokenId)
    {
        _validate(name);

        tokenId = tokenIdOf(name);
        if (reserved[tokenId]) revert NameReserved();
        if (_ownerOf[tokenId] != address(0)) revert NameTaken();

        uint256 price = _priceForLength(bytes(name).length);
        if (msg.value < price) revert Underpaid(price, msg.value);

        _validateCid(cid);

        nameOf[tokenId] = name;
        _records[tokenId] = Record({
            cid: cid,
            contentType: contentType,
            updatedAt: uint64(block.timestamp),
            frozen: false
        });

        unchecked {
            totalRegistered++;
        }

        _mint(msg.sender, tokenId);

        emit NameRegistered(tokenId, name, msg.sender, cid);
        emit CidUpdated(tokenId, cid, contentType);

        // Refund the overage. Checks-effects-interactions: all state is already written.
        if (msg.value > price) {
            _refund(msg.sender, msg.value - price);
        }
    }

    /// @notice Repoint a name at a new CID. Costs `updateFee` — this covers the real
    ///         cost of pinning the new content, and stops the contract from being free
    ///         mutable storage. Free for the contract owner (migrations only).
    function setCid(uint256 tokenId, string calldata cid, string calldata contentType)
        external
        payable
    {
        if (_ownerOf[tokenId] != msg.sender) revert NotNameOwner();

        Record storage r = _records[tokenId];
        if (r.frozen) revert RecordIsFrozen();

        uint256 fee = msg.sender == owner ? 0 : updateFee;
        if (msg.value < fee) revert Underpaid(fee, msg.value);

        _validateCid(cid);

        r.cid = cid;
        r.contentType = contentType;
        r.updatedAt = uint64(block.timestamp);

        emit CidUpdated(tokenId, cid, contentType);

        if (msg.value > fee) {
            _refund(msg.sender, msg.value - fee);
        }
    }

    /// @notice Make this name's record immutable FOREVER.
    /// @dev    There is deliberately no unfreeze. This is the trust primitive for
    ///         `curl -sSL wget.club/x | bash`: it proves to anyone downloading that
    ///         the script cannot be swapped out from under them after they audit it.
    ///         An unfreeze would destroy the entire guarantee. Do not add one.
    function freeze(uint256 tokenId) external {
        if (_ownerOf[tokenId] != msg.sender) revert NotNameOwner();
        Record storage r = _records[tokenId];
        if (r.frozen) revert RecordIsFrozen();
        r.frozen = true;
        emit RecordFrozen(tokenId);
    }

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    /// @dev Source of truth for name rules. packages/shared/src/name.ts mirrors this
    ///      for the UI; contracts/test/NameParity.t.sol fuzzes them against each other.
    function _validate(string calldata name) internal pure {
        bytes calldata b = bytes(name);
        uint256 len = b.length;

        if (len < MIN_LENGTH) revert NameTooShort();
        if (len > MAX_LENGTH) revert NameTooLong();

        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            if (!_isAlnum(c) && !_isSeparator(c)) revert InvalidCharacter(c);
        }

        if (!_isAlnum(b[0])) revert MustStartAlphanumeric();
        if (!_isAlnum(b[len - 1])) revert MustEndAlphanumeric();

        for (uint256 i = 1; i < len; i++) {
            if (_isSeparator(b[i]) && _isSeparator(b[i - 1])) revert ConsecutiveSeparators();
        }
    }

    function _isValid(string calldata name) internal pure returns (bool) {
        bytes calldata b = bytes(name);
        uint256 len = b.length;

        if (len < MIN_LENGTH || len > MAX_LENGTH) return false;
        if (!_isAlnum(b[0]) || !_isAlnum(b[len - 1])) return false;

        for (uint256 i = 0; i < len; i++) {
            bytes1 c = b[i];
            if (!_isAlnum(c) && !_isSeparator(c)) return false;
            if (i > 0 && _isSeparator(c) && _isSeparator(b[i - 1])) return false;
        }
        return true;
    }

    /// @dev Lowercase only. Rejecting uppercase on-chain is what makes it impossible
    ///      for "Setup.sh" and "setup.sh" to be two different owners' NFTs — a
    ///      homograph phishing vector. See docs/SECURITY.md.
    function _isAlnum(bytes1 c) private pure returns (bool) {
        return (c >= 0x61 && c <= 0x7A) // a-z
            || (c >= 0x30 && c <= 0x39); // 0-9
    }

    function _isSeparator(bytes1 c) private pure returns (bool) {
        return c == 0x2D || c == 0x2E || c == 0x5F; // - . _
    }

    /// @dev The resolver interpolates this CID into a gateway URL, so a malformed
    ///      value is an SSRF vector. We bound length and charset here; the resolver
    ///      re-validates with the full CID grammar before any fetch. Belt and braces —
    ///      full base32/base58 decoding on-chain is not worth the gas.
    function _validateCid(string calldata cid) internal pure {
        bytes calldata b = bytes(cid);
        if (b.length == 0) revert EmptyCid();
        if (b.length > 111) revert CidTooLong();

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool alnum = (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39);
            if (!alnum) revert InvalidCharacter(c);
        }
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setPrice(uint256 length, uint256 wei_) external onlyOwner {
        priceByLength[length] = wei_;
        emit PriceChanged(length, wei_);
    }

    function setTailPrice(uint256 wei_) external onlyOwner {
        tailPrice = wei_;
        emit PriceChanged(type(uint256).max, wei_);
    }

    function setUpdateFee(uint256 wei_) external onlyOwner {
        updateFee = wei_;
        emit UpdateFeeChanged(wei_);
    }

    /// @notice Release a reserved name so it can be minted.
    /// @dev    There is no `reserve()` counterpart, on purpose. If the owner could
    ///         reserve arbitrary names, they could freeze any name someone is about
    ///         to buy — or front-run a purchase. Reservation is set once, at
    ///         construction, and only ever shrinks.
    function unreserve(string calldata name) external onlyOwner {
        uint256 id = tokenIdOf(name);
        if (!reserved[id]) revert NotReserved();
        reserved[id] = false;
        emit Unreserved(name);
    }

    function setRoyaltyReceiver(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        royaltyReceiver = r;
    }

    function withdraw(address to) external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToWithdraw();
        (bool ok,) = to.call{value: bal}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(to, bal);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev Refunds are last, after all state writes, so a malicious receiver's
    ///      fallback cannot re-enter into a half-written registration.
    function _refund(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // -------------------------------------------------------------------------
    // ERC-721 / ERC-2981
    // -------------------------------------------------------------------------

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        // Metadata is rendered by the API worker: name, CID, frozen badge, preview.
        // Keeping it off-chain means we can improve the card art without a migration.
        return string.concat("https://wget.club/api/nft/", _toString(tokenId));
    }

    function royaltyInfo(uint256, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 amount)
    {
        return (royaltyReceiver, (salePrice * ROYALTY_BPS) / 10_000);
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC165
            || interfaceId == 0x80ac58cd // ERC721
            || interfaceId == 0x5b5e139f // ERC721Metadata
            || interfaceId == 0x2a55205a; // ERC2981
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) digits++;
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
