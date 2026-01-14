// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import "@aave/core-v3/contracts/flashloan/base/FlashLoanSimpleReceiverBase.sol";
import "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IAggregator {
    struct SwapDescription {
        IERC20 srcToken;
        IERC20 dstToken;
        address payable srcReceiver;
        address payable dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
        bytes permit;
    }
    
    function swap(
        address executor,
        SwapDescription calldata desc,
        bytes calldata data
    ) external payable returns (uint256 returnAmount);
}

interface IBaseAggregator {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
    
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract BaseAlphaArb is FlashLoanSimpleReceiverBase, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // Base Chain Aave V3 Addresses
    IPoolAddressesProvider public constant ADDRESSES_PROVIDER = 
        IPoolAddressesProvider(0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D);
    
    // Base Chain Aggregators
    address public constant ODOS_AGGREGATOR = 0x19cEeAd7105607Cd444F5ad10dd51356436095a1;
    address public constant ONE_INCH_AGGREGATOR = 0x1111111254EEB25477B68fb85Ed929f73A960582;
    address public constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address public constant PANCAKESWAP_ROUTER = 0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86;
    address public constant UNISWAP_V3_ROUTER = 0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24;
    
    // Base Tokens
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant cbETH = 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
    
    struct ArbitrageHop {
        address aggregator;
        address fromToken;
        address toToken;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes swapData;
        bool useEth;
    }
    
    struct ArbitragePath {
        ArbitrageHop[] hops;
        uint256 minProfit;
        uint256 deadline;
    }
    
    event ArbitrageExecuted(
        address indexed executor,
        address flashLoanToken,
        uint256 flashLoanAmount,
        uint256 profit,
        uint256 timestamp
    );
    
    event ArbitrageFailed(
        address indexed executor,
        string reason,
        uint256 timestamp
    );
    
    event AggregatorUpdated(
        string name,
        address oldAddress,
        address newAddress
    );
    
    // Custom aggregator mappings for upgradability
    mapping(string => address) public aggregators;
    
    constructor()
        FlashLoanSimpleReceiverBase(ADDRESSES_PROVIDER)
        Ownable(msg.sender)
    {
        // Initialize aggregators
        aggregators["odos"] = ODOS_AGGREGATOR;
        aggregators["1inch"] = ONE_INCH_AGGREGATOR;
        aggregators["aerodrome"] = AERODROME_ROUTER;
        aggregators["pancakeswap"] = PANCAKESWAP_ROUTER;
        aggregators["uniswap_v3"] = UNISWAP_V3_ROUTER;
        
        // Approve max for known aggregators
        _setMaxApprovals();
    }
    
    function _setMaxApprovals() internal {
        address[] memory tokens = new address[](3);
        tokens[0] = WETH;
        tokens[1] = USDC;
        tokens[2] = cbETH;
        
        address[] memory routers = new address[](5);
        routers[0] = ODOS_AGGREGATOR;
        routers[1] = ONE_INCH_AGGREGATOR;
        routers[2] = AERODROME_ROUTER;
        routers[3] = PANCAKESWAP_ROUTER;
        routers[4] = UNISWAP_V3_ROUTER;
        
        for (uint256 i = 0; i < tokens.length; i++) {
            for (uint256 j = 0; j < routers.length; j++) {
                IERC20(tokens[i]).safeApprove(routers[j], type(uint256).max);
            }
        }
    }
    
    function executeArbitrage(
        ArbitragePath calldata path,
        uint256 flashLoanAmount
    ) external onlyOwner whenNotPaused nonReentrant returns (bool) {
        require(path.hops.length > 0, "Invalid path length");
        require(flashLoanAmount > 0, "Invalid flash loan amount");
        require(path.deadline > block.timestamp, "Deadline expired");
        
        address flashLoanToken = path.hops[0].fromToken;
        
        // Request flash loan
        POOL.flashLoanSimple(
            address(this),
            flashLoanToken,
            flashLoanAmount,
            abi.encode(path),
            0
        );
        
        return true;
    }
    
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(POOL), "Invalid caller");
        require(initiator == owner(), "Invalid initiator");
        require(!paused(), "Contract paused");
        
        ArbitragePath memory path = abi.decode(params, (ArbitragePath));
        
        require(path.hops[0].fromToken == asset, "Token mismatch");
        require(path.deadline >= block.timestamp, "Arbitrage deadline expired");
        
        // Store initial balance for profit calculation
        uint256 initialBalance = IERC20(asset).balanceOf(address(this));
        
        // Execute each swap in the path
        for (uint256 i = 0; i < path.hops.length; i++) {
            ArbitrageHop memory hop = path.hops[i];
            
            require(hop.aggregator != address(0), "Invalid aggregator");
            require(hop.fromToken != address(0) && hop.toToken != address(0), "Invalid token");
            
            uint256 balanceBefore = IERC20(hop.toToken).balanceOf(address(this));
            
            // Execute swap based on aggregator type
            if (hop.aggregator == ODOS_AGGREGATOR) {
                _executeOdosSwap(hop);
            } else if (hop.aggregator == ONE_INCH_AGGREGATOR) {
                _executeOneInchSwap(hop);
            } else if (hop.aggregator == AERODROME_ROUTER || 
                       hop.aggregator == PANCAKESWAP_ROUTER ||
                       hop.aggregator == UNISWAP_V3_ROUTER) {
                _executeDexSwap(hop);
            } else {
                _executeGenericSwap(hop);
            }
            
            uint256 balanceAfter = IERC20(hop.toToken).balanceOf(address(this));
            uint256 amountOut = balanceAfter - balanceBefore;
            
            require(amountOut >= hop.minAmountOut, "Slippage too high");
            
            // Reset approval for safety
            if (i < path.hops.length - 1) {
                IERC20(hop.fromToken).safeApprove(hop.aggregator, 0);
            }
        }
        
        // Calculate final profit
        uint256 finalBalance = IERC20(asset).balanceOf(address(this));
        uint256 totalDebt = amount + premium;
        
        require(finalBalance >= totalDebt, "Insufficient funds to repay flash loan");
        
        uint256 profit = finalBalance - totalDebt;
        require(profit >= path.minProfit, "Profit below minimum threshold");
        
        // Repay flash loan
        IERC20(asset).safeTransfer(address(POOL), totalDebt);
        
        // Transfer profit to owner if any
        if (profit > 0) {
            IERC20(asset).safeTransfer(owner(), profit);
        }
        
        emit ArbitrageExecuted(
            msg.sender,
            asset,
            amount,
            profit,
            block.timestamp
        );
        
        return true;
    }
    
    function _executeOdosSwap(ArbitrageHop memory hop) internal {
        IAggregator.SwapDescription memory desc = IAggregator.SwapDescription({
            srcToken: IERC20(hop.fromToken),
            dstToken: IERC20(hop.toToken),
            srcReceiver: payable(address(this)),
            dstReceiver: payable(address(this)),
            amount: hop.amountIn,
            minReturnAmount: hop.minAmountOut,
            flags: 0,
            permit: ""
        });
        
        IAggregator(hop.aggregator).swap(
            address(this),
            desc,
            hop.swapData
        );
    }
    
    function _executeOneInchSwap(ArbitrageHop memory hop) internal {
        (bool success, ) = hop.aggregator.call(hop.swapData);
        require(success, "1inch swap failed");
    }
    
    function _executeDexSwap(ArbitrageHop memory hop) internal {
        address[] memory path = new address[](2);
        path[0] = hop.fromToken;
        path[1] = hop.toToken;
        
        if (hop.useEth && hop.fromToken == WETH) {
            // Handle ETH wrapping/unwrapping if needed
            IBaseAggregator(hop.aggregator).swapExactETHForTokens{value: 0}(
                hop.minAmountOut,
                path,
                address(this),
                block.timestamp + 300
            );
        } else {
            IBaseAggregator(hop.aggregator).swapExactTokensForTokens(
                hop.amountIn,
                hop.minAmountOut,
                path,
                address(this),
                block.timestamp + 300
            );
        }
    }
    
    function _executeGenericSwap(ArbitrageHop memory hop) internal {
        (bool success, ) = hop.aggregator.call(hop.swapData);
        require(success, "Generic swap failed");
    }
    
    // Emergency pause function
    function emergencyPause() external onlyOwner {
        _pause();
    }
    
    function emergencyUnpause() external onlyOwner {
        _unpause();
    }
    
    // Update aggregator address
    function updateAggregator(string memory name, address newAddress) external onlyOwner {
        require(newAddress != address(0), "Invalid address");
        address oldAddress = aggregators[name];
        aggregators[name] = newAddress;
        
        emit AggregatorUpdated(name, oldAddress, newAddress);
    }
    
    // Rescue functions
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
    
    function rescueETH(uint256 amount) external onlyOwner {
        payable(owner()).transfer(amount);
    }
    
    // View functions
    function getAggregator(string memory name) external view returns (address) {
        return aggregators[name];
    }
    
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
    
    function getContractETHBalance() external view returns (uint256) {
        return address(this).balance;
    }
    
    // Required for receiving ETH from swaps
    receive() external payable {}
}
