pragma solidity ^0.5.0;

import "./ChainlinkConversionPath.sol";
import "./interfaces/ERC20FeeProxy.sol";


/**
 * @title ProxyChainlinkConversionPath
 */
contract ProxyChainlinkConversionPath {
  using SafeMath for uint256;

  // rate must have been updated before the last... 10min (TODO !)
  uint256 public maxTimestampDeltaAcceptable = 600;

  address public paymentProxy;
  ChainlinkConversionPath public chainlinkConversionPath;

  constructor(address _paymentProxyAddress, address _chainlinkConversionPathAddress) public {
    paymentProxy = _paymentProxyAddress;
    chainlinkConversionPath = ChainlinkConversionPath(_chainlinkConversionPathAddress);
  }

  // Event to declare a transfer with a reference
  event TransferWithReferenceAndFee(
    address paymentCurrency,
    address to,
    uint256 requestAmount,
    address requestCurrency,
    bytes indexed paymentReference,
    uint256 feesRequestAmount,
    address feesTo
  );

  /**
   * @notice Performs an ERC20 token transfer with a reference computing the amount based on a fiat amount
   * @param _to Transfer recipient
   * @param _requestAmount request amount
   * @param _path conversion path
   * @param _paymentReference Reference of the payment related
   * @param _feesRequestAmount The amount of the payment fee
   * @param _feesTo The fee recipient
   * @param _maxToSpend amount max that we can spend on the behalf of the user
   */
  function transferFromWithReferenceAndFee(
    address _to,
    uint256 _requestAmount,
    address[] calldata _path,
    bytes calldata _paymentReference,
    uint256 _feesRequestAmount,
    address _feesTo,
    uint256 _maxToSpend
  ) external
  {
    // TODO !
    require(_path[_path.length - 1] != address(0x0), "ETH not supported yet");

    (uint256 amountToPay, uint256 amountToPayInFees) = getConversions(_path, _requestAmount, _feesRequestAmount);

    require(amountToPay.add(amountToPayInFees) <= _maxToSpend, "Amount to pay is over the user limit");

    // Pay the request and fees
    (bool status, ) = paymentProxy.delegatecall(
      abi.encodeWithSignature(
        "transferFromWithReferenceAndFee(address,address,uint256,bytes,uint256,address)",
        // payment currency
        _path[_path.length - 1],
        _to,
        amountToPay,
        _paymentReference,
        amountToPayInFees,
        _feesTo
      )
    );
    require(status, "transferFromWithReferenceAndFee failed");

    // Event to declare a transfer with a reference
    emit TransferWithReferenceAndFee(
      // payment currency
      _path[_path.length - 1],
      _to,
      _requestAmount,
      _path[0], // request currency
      _paymentReference,
      _feesRequestAmount,
      _feesTo
    );
  }

  function getConversions(
    address[] memory _path,
    uint256 _requestAmount,
    uint256 _feesRequestAmount
  ) internal
    returns (uint256 amountToPay, uint256 amountToPayInFees)
  {
    (uint256 rate, uint256 oldestTimestampRate, uint256 decimals) = chainlinkConversionPath.getRate(_path);

    // Check rate timestamp
    require(block.timestamp.sub(oldestTimestampRate) <= maxTimestampDeltaAcceptable, "aggregator rate is outdated");
    
    // Get the amount to pay in the crypto currency chosen
    amountToPay = _requestAmount.mul(rate).div(decimals);
    amountToPayInFees = _feesRequestAmount.mul(rate).div(decimals);
  }
}
