import { ExtensionTypes, IdentityTypes, RequestLogicTypes } from '@requestnetwork/types';
import Utils from '@requestnetwork/utils';
import ReferenceBased from './reference-based';

import Erc20FeeProxyPaymentNetwork from './erc20/fee-proxy-contract';

const CURRENT_VERSION = '0.1.0';
// Default network if the storage data does not give any
const DEFAULT_NETWORK = 'mainnet';

// /**
//  * Implementation of the payment network to pay in ERC20, including third-party fees payment, based on a reference provided to a proxy contract.
//  * With this extension, one request can have three Ethereum addresses (one for payment, one for fees payment, and one for refund)
//  * Every ERC20 ethereum transaction that reaches these addresses through the proxy contract and has the correct reference will be interpreted as a payment or a refund.
//  * The value to give as input data is the last 8 bytes of a salted hash of the requestId and the address: `last8Bytes(hash(requestId + salt + address))`:
//  * The salt should have at least 8 bytes of randomness. A way to generate it is:
//  *   `Math.floor(Math.random() * Math.pow(2, 4 * 8)).toString(16) + Math.floor(Math.random() * Math.pow(2, 4 * 8)).toString(16)`
//  */
// const conversionErc20FeeProxyContract: ExtensionTypes.PnAnyToErc20.IAnyToERC20 = {
//   applyActionToExtension,
//   createAddFeeAction,
//   createAddPaymentAddressAction,
//   createAddRefundAddressAction,
//   createCreationAction,
//   isValidAddress,
// };

/**
 * These currencies are supported by Chainlink for conversion.
 * Only ERC20 is supported as accepted token by the payment proxy.
 */
const supportedCurrencies: Record<string, Record<RequestLogicTypes.CURRENCY, string[]>> = {
  private: {
    [RequestLogicTypes.CURRENCY.ISO4217]: ['USD', 'EUR'],
    [RequestLogicTypes.CURRENCY.ERC20]: ['0x38cf23c52bb4b13f051aec09580a2de845a7fa35'],
    [RequestLogicTypes.CURRENCY.ETH]: ['ETH'],
    [RequestLogicTypes.CURRENCY.BTC]: [],
  },
  rinkeby: {
    [RequestLogicTypes.CURRENCY.ISO4217]: ['EUR', 'GBP', 'USD'],
    [RequestLogicTypes.CURRENCY.ERC20]: ['0xfab46e002bbf0b4509813474841e0716e6730136'],
    [RequestLogicTypes.CURRENCY.ETH]: ['ETH'],
    [RequestLogicTypes.CURRENCY.BTC]: [],
  },
  mainnet: {
    [RequestLogicTypes.CURRENCY.ISO4217]: ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'SGD', 'USD'],
    [RequestLogicTypes.CURRENCY.ERC20]: [
      '0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c',
      '0x3845badade8e6dff049820680d1f14bd3903a5d0',
      '0x4e15361fd6b4bb609fa63c81a2be19d873717870',
      '0x6b175474e89094c44da98b954eedeac495271d0f',
      '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
      '0x8290333cef9e6d528dd5618fb97a76f268f3edd4',
      '0x967da4048cd07ab37855c090aaf366e4ce1b9f48',
      '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      '0xa117000000f279d81a1d3cc75430faa017fa5a2e',
      '0xc944e90c64b2c07662a292be6244bdf05cda44a7',
      '0xdac17f958d2ee523a2206206994597c13d831ec7',
    ],
    [RequestLogicTypes.CURRENCY.ETH]: ['ETH'],
    [RequestLogicTypes.CURRENCY.BTC]: [],
  },
};

export default class AnyToErc20ProxyPaymentNetwork extends Erc20FeeProxyPaymentNetwork {
  public constructor() {
    super();
    this.currentVersion = CURRENT_VERSION;
    this.paymentNetworkId = ExtensionTypes.ID.PAYMENT_NETWORK_ANY_TO_ERC20_PROXY;
  }

  /**
   * Creates the extensionsData to create the extension ERC20 fee proxy contract payment detection
   *
   * @param creationParameters extensions parameters to create
   *
   * @returns IExtensionCreationAction the extensionsData to be stored in the request
   */
  public createCreationAction(
    creationParameters: ExtensionTypes.PnAnyToErc20.ICreationParameters,
  ): ExtensionTypes.IAction {
    if (!creationParameters.acceptedTokens || creationParameters.acceptedTokens.length === 0) {
      throw Error('acceptedTokens is required');
    }
    if (creationParameters.acceptedTokens.some((address) => !this.isValidAddress(address))) {
      throw Error('acceptedTokens must contains only valid ethereum addresses');
    }

    const network = creationParameters.network;
    if (!network) {
      throw Error('network is required');
    }
    if (!supportedCurrencies[network]) {
      throw Error(`network ${network} not supported`);
    }
    const supportedErc20: string[] = supportedCurrencies[network][RequestLogicTypes.CURRENCY.ERC20];

    for (const address of creationParameters.acceptedTokens) {
      if (!supportedErc20.includes(address.toLowerCase())) {
        throw Error(
          `acceptedTokens must contain only supported token addresses (ERC20 only). ${address} is not supported for ${network}.`,
        );
      }
    }

    return super.createCreationAction(creationParameters);
  }

  /**
   * Applies the extension action to the request state
   * Is called to interpret the extensions data when applying the transaction
   *
   * @param extensionsState previous state of the extensions
   * @param extensionAction action to apply
   * @param requestState request state read-only
   * @param actionSigner identity of the signer
   *
   * @returns state of the request updated
   */
  public applyActionToExtension(
    extensionsState: RequestLogicTypes.IExtensionStates,
    extensionAction: ExtensionTypes.IAction,
    requestState: RequestLogicTypes.IRequest,
    actionSigner: IdentityTypes.IIdentity,
    timestamp: number,
  ): RequestLogicTypes.IExtensionStates {
    this.checkSupportedCurrency(
      requestState.currency,
      extensionAction.parameters.network || DEFAULT_NETWORK,
    );

    const copiedExtensionState: RequestLogicTypes.IExtensionStates = Utils.deepCopy(
      extensionsState,
    );

    if (extensionAction.action === ExtensionTypes.PnFeeReferenceBased.ACTION.CREATE) {
      if (requestState.extensions[extensionAction.id]) {
        throw Error(`This extension has already been created`);
      }

      copiedExtensionState[extensionAction.id] = this.applyCreation(extensionAction, timestamp);

      return copiedExtensionState;
    }

    // if the action is not "create", the state must have been created before
    if (!requestState.extensions[extensionAction.id]) {
      throw Error(`The extension should be created before receiving any other action`);
    }

    if (extensionAction.action === ExtensionTypes.PnFeeReferenceBased.ACTION.ADD_PAYMENT_ADDRESS) {
      copiedExtensionState[extensionAction.id] = ReferenceBased.applyAddPaymentAddress(
        this.isValidAddress,
        copiedExtensionState[extensionAction.id],
        extensionAction,
        requestState,
        actionSigner,
        timestamp,
      );

      return copiedExtensionState;
    }

    if (extensionAction.action === ExtensionTypes.PnFeeReferenceBased.ACTION.ADD_REFUND_ADDRESS) {
      copiedExtensionState[extensionAction.id] = ReferenceBased.applyAddRefundAddress(
        this.isValidAddress,
        copiedExtensionState[extensionAction.id],
        extensionAction,
        requestState,
        actionSigner,
        timestamp,
      );

      return copiedExtensionState;
    }

    if (extensionAction.action === ExtensionTypes.PnFeeReferenceBased.ACTION.ADD_FEE) {
      copiedExtensionState[extensionAction.id] = this.applyAddFee(
        copiedExtensionState[extensionAction.id],
        extensionAction,
        requestState,
        actionSigner,
        timestamp,
      );

      return copiedExtensionState;
    }

    throw Error(`Unknown action: ${extensionAction.action}`);
  }

  /**
   * Applies a creation extension action
   *
   * @param extensionAction action to apply
   * @param timestamp action timestamp
   *
   * @returns state of the extension created
   */
  protected applyCreation(
    extensionAction: ExtensionTypes.IAction,
    timestamp: number,
  ): ExtensionTypes.IState {
    if (!extensionAction.parameters.network || extensionAction.parameters.network.length === 0) {
      throw Error('network is required');
    }

    if (
      !extensionAction.parameters.acceptedTokens ||
      extensionAction.parameters.acceptedTokens.length === 0
    ) {
      throw Error('acceptedTokens is required and cannot be empty');
    }
    if (
      extensionAction.parameters.acceptedTokens.some(
        (address: string) => !this.isValidAddress(address),
      )
    ) {
      throw Error('acceptedTokens must contains only valid ethereum addresses');
    }

    const feePNCreationAction = super.applyCreation(extensionAction, timestamp);

    return {
      ...feePNCreationAction,
      events: [
        {
          name: 'create',
          parameters: {
            feeAddress: extensionAction.parameters.feeAddress,
            feeAmount: extensionAction.parameters.feeAmount,
            paymentAddress: extensionAction.parameters.paymentAddress,
            refundAddress: extensionAction.parameters.refundAddress,
            salt: extensionAction.parameters.salt,
            network: extensionAction.parameters.network || DEFAULT_NETWORK,
            acceptedTokens: extensionAction.parameters.acceptedTokens,
            maxRateTimespan: extensionAction.parameters.maxRateTimespan,
          },
          timestamp,
        },
      ],
      values: {
        ...feePNCreationAction.values,
        network: extensionAction.parameters.network || DEFAULT_NETWORK,
        acceptedTokens: extensionAction.parameters.acceptedTokens,
        maxRateTimespan: extensionAction.parameters.maxRateTimespan,
      },
    };
  }

  /**
   * Throw if a currency is not supported
   *
   * @param currency currency to check
   * @param network network of the payment
   */
  protected checkSupportedCurrency(currency: RequestLogicTypes.ICurrency, network: string): void {
    if (!supportedCurrencies[network]) {
      throw new Error(`The network (${network}) is not supported for this payment network.`);
    }

    if (!supportedCurrencies[network][currency.type]) {
      throw new Error(
        `The currency type (${currency.type}) of the request is not supported for this payment network.`,
      );
    }

    let normalizedCurrencyValue = currency.value;
    if (currency.type !== RequestLogicTypes.CURRENCY.ISO4217) {
      normalizedCurrencyValue = currency.value.toLowerCase();
    }

    if (!supportedCurrencies[network][currency.type].includes(normalizedCurrencyValue)) {
      throw new Error(
        `The currency (${currency.value}) of the request is not supported for this payment network.`,
      );
    }
  }
}
