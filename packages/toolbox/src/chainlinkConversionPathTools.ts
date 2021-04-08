import { ethers } from 'ethers';
import { chainlinkConversionPath } from '@requestnetwork/smart-contracts';
import * as yargs from 'yargs';
import { getCurrencyHash, stringToCurrency } from '@requestnetwork/currency';
import { LogDescription } from 'ethers/lib/utils';

// ABI fragment containing AggregatorUpdated event
const chainlinkConversionPathAbiFragment = [
  'event AggregatorUpdated(address _input, address _output, address _aggregator)',
];

interface IOptions {
  network?: string;
  currencyCode?: string;
}

/** TransferWithReference event */
type AggregatorUpdatedArgs = {
  _input: string;
  _output: string;
  _aggregator: string;
};

/**
 * Converts the Log's args from array to an object with keys being the name of the arguments
 */
export const parseLogArgs = <T>({ args, eventFragment }: LogDescription): T => {
  return args.reduce((prev, current, i) => {
    prev[eventFragment.inputs[i].name] = current;
    return prev;
  }, {});
};

/**
 * Retrieves a list of payment events from a payment reference, a destination address, a token address and a proxy contract
 */
class ChainlinkConversionPathTools {
  public contractChainlinkConversionPath: ethers.Contract;
  public chainlinkConversionPathCreationBlockNumber: number;
  public provider: ethers.providers.Provider;

  /**
   * @param network The Ethereum network to use
   */
  constructor(private network: string) {
    // Creates a local or default provider
    this.provider =
      this.network === 'private'
        ? new ethers.providers.JsonRpcProvider()
        : ethers.getDefaultProvider(this.network);

    // Setup the conversion proxy contract interface
    this.contractChainlinkConversionPath = new ethers.Contract(
      chainlinkConversionPath.getAddress(this.network),
      chainlinkConversionPathAbiFragment,
      this.provider,
    );
    this.chainlinkConversionPathCreationBlockNumber = chainlinkConversionPath.getCreationBlockNumber(
      this.network,
    );
  }

  /**
   * Retrieves all the aggregators
   */
  public async getAggregators(): Promise<any> {
    // Create a filter to find all the Fee Transfer logs with the payment reference
    const conversionFilter = this.contractChainlinkConversionPath.filters.AggregatorUpdated() as ethers.providers.Filter;
    conversionFilter.fromBlock = this.chainlinkConversionPathCreationBlockNumber;
    conversionFilter.toBlock = 'latest';

    // Get the fee proxy contract event logs
    const logs = await this.provider.getLogs(conversionFilter);

    // Parses, filters and creates the events from the logs with the payment reference
    const aggregatorsMaps = logs.reduce(
      // Map: Input currency => Output currency => aggregator address
      (aggregators: Map<string, Map<string, string>>, log: any) => {
        const parsedLog = this.contractChainlinkConversionPath.interface.parseLog(log);
        const args = parseLogArgs<AggregatorUpdatedArgs>(parsedLog);

        // if the aggregator in 0x00 it means, it has been deleted
        if (args._aggregator === '0x0000000000000000000000000000000000000000') {
          aggregators.get(args._input)?.delete(args._output);
          if (aggregators.get(args._input)?.size === 0) {
            aggregators.delete(args._input);
          }
        } else {
          if (!aggregators.has(args._input)) {
            // if input  does not exists we just add it with the output currency
            aggregators.set(args._input, new Map([[args._output, args._aggregator]]));
          } else {
            // otherwise we just add a new output currency for this input currency
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            aggregators.get(args._input)!.set(args._output, args._aggregator);
          }
        }

        return aggregators;
      },
      new Map(),
    );

    // From Map to Object to be easier to manipulate later
    const aggregatorsAsObject: { [key: string]: { [key: string]: string } } = {};
    aggregatorsMaps.forEach((elemL1: Map<string, string>, keyL1: string) => {
      aggregatorsAsObject[keyL1.toLocaleLowerCase()] = {};
      elemL1.forEach((aggregator: string, keyL2: string) => {
        aggregatorsAsObject[keyL1.toLocaleLowerCase()][keyL2.toLocaleLowerCase()] = aggregator;
      });
    });

    return aggregatorsAsObject;
  }
}

const listAggregators = async (options?: IOptions): Promise<void> => {
  const networks = options?.network ? [options.network] : ['private', 'rinkeby', 'mainnet'];

  // Create an Object to be used by a dijkstra algorithm to find the best path between two currencies
  const allAggregators: any = {};
  const aggregatorsNodesForDijkstra: any = {};
  for (const network of networks) {
    allAggregators[network] = {};
    const chainlinkConversionPathTools = new ChainlinkConversionPathTools(network);
    allAggregators[network] = await chainlinkConversionPathTools.getAggregators();

    // Include the reverse path of each aggregators
    aggregatorsNodesForDijkstra[network] = {};
    for (let ccyIn in allAggregators[network]) {
      ccyIn = ccyIn.toLowerCase();
      if (!aggregatorsNodesForDijkstra[network][ccyIn]) {
        aggregatorsNodesForDijkstra[network][ccyIn] = {};
      }
      for (let ccyOut in allAggregators[network][ccyIn]) {
        ccyOut = ccyOut.toLowerCase();
        if (!aggregatorsNodesForDijkstra[network][ccyOut]) {
          aggregatorsNodesForDijkstra[network][ccyOut] = {};
        }
        aggregatorsNodesForDijkstra[network][ccyIn][ccyOut] = 1;
        aggregatorsNodesForDijkstra[network][ccyOut][ccyIn] = 1;
      }
    }
  }

  console.log('#####################################################################');
  console.log('All aggregators:');
  console.log(allAggregators);
  console.log('#####################################################################');
  console.log('All aggregators nodes for currency pairs graph:');
  console.log(aggregatorsNodesForDijkstra);
  console.log('#####################################################################');
};

export const chainlinkAggregatorsCommandModule: yargs.CommandModule<{}, IOptions> = {
  command: 'listAggregators <network>',
  describe: 'Helper for on-chain conversion administration',
  builder: (yargs) =>
    yargs.options({
      network: {
        demand: false,
        type: 'string',
        desc: 'Network for which to list aggregators (mainnet, rinkeby, private)',
      },
    }),
  handler: listAggregators,
};

const showCurrencyHash = async (options?: IOptions): Promise<void> => {
  if (!options?.currencyCode) {
    throw new Error('currencyCode missing');
  }
  console.log('#####################################################################');
  console.log(`Currency hash of: ${options.currencyCode}`);
  console.log(getCurrencyHash(stringToCurrency(options.currencyCode)));
  console.log('#####################################################################');
};

export const currencyHashCommandModule: yargs.CommandModule<{}, IOptions> = {
  command: 'currencyHash <currencyCode>',
  describe: 'Shows the currency hash of a currency code',
  builder: (yargs) =>
    yargs.options({
      currencyCode: {
        demand: true,
        type: 'string',
        desc: 'Currency code such as ETH or EUR',
      },
    }),
  handler: showCurrencyHash,
};
