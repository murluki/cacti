import { Account } from "web3-core";
import { v4 as uuidv4 } from "uuid";
import { DiscoveryOptions } from "fabric-network";
import {
  Logger,
  LogLevelDesc,
  LoggerProvider,
} from "@hyperledger/cactus-common";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { PluginLedgerConnectorBesu } from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import {
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-quorum";
import { IPluginKeychain } from "@hyperledger/cactus-core-api";
import { FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1 } from "@hyperledger/cactus-test-tooling";
import { FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2 } from "@hyperledger/cactus-test-tooling";
import {
  BesuTestLedger,
  DEFAULT_FABRIC_2_AIO_IMAGE_NAME,
  FABRIC_25_LTS_AIO_FABRIC_VERSION,
  FABRIC_25_LTS_AIO_IMAGE_VERSION,
  FabricTestLedgerV1,
} from "@hyperledger/cactus-test-tooling";
import {
  IEthContractDeployment,
  ISupplyChainContractDeploymentInfo,
  IFabricContractDeployment,
} from "@hyperledger/cactus-example-supply-chain-business-logic-plugin";
import {
  PluginLedgerConnectorFabric,
  DefaultEventHandlerStrategy,
} from "@hyperledger/cactus-plugin-ledger-connector-fabric";

import BambooHarvestRepositoryJSON from "../../json/generated/BambooHarvestRepository.json";
import BookshelfRepositoryJSON from "../../json/generated/BookshelfRepository.json";
import { SHIPMENT_CONTRACT_GO_SOURCE } from "../../go/shipment";
import { SHIPMENT_GOLANG_CONTRACT_PINNED_DEPENDENCIES } from "./shipment-golang-contract-pinned-dependencies";

export interface ISupplyChainAppDummyInfrastructureOptions {
  logLevel?: LogLevelDesc;
  keychain?: IPluginKeychain;
}

export class SupplyChainAppDummyInfrastructure {
  public static readonly CLASS_NAME = "SupplyChainAppDummyInfrastructure";

  public readonly besu: BesuTestLedger;
  public readonly fabric: FabricTestLedgerV1;
  public readonly keychain: IPluginKeychain;
  private readonly log: Logger;
  private _besuAccount?: Account;

  public get besuAccount(): Account {
    if (!this._besuAccount) {
      throw new Error(`Must call deployContracts() first.`);
    } else {
      return this._besuAccount;
    }
  }

  public get className(): string {
    return SupplyChainAppDummyInfrastructure.CLASS_NAME;
  }

  constructor(
    public readonly options: ISupplyChainAppDummyInfrastructureOptions,
  ) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);

    const level = this.options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });

    this.besu = new BesuTestLedger({
      logLevel: level,
      emitContainerLogs: true,
    });
    this.fabric = new FabricTestLedgerV1({
      publishAllPorts: true,
      imageName: DEFAULT_FABRIC_2_AIO_IMAGE_NAME,
      imageVersion: FABRIC_25_LTS_AIO_IMAGE_VERSION,
      logLevel: level,
      envVars: new Map([["FABRIC_VERSION", FABRIC_25_LTS_AIO_FABRIC_VERSION]),
      emitContainerLogs: true,
    });

    if (this.options.keychain) {
      this.keychain = this.options.keychain;
      this.log.info("Reusing the provided keychain plugin...");
    } else {
      this.log.info("Instantiating new keychain plugin...");
      this.keychain = new PluginKeychainMemory({
        instanceId: uuidv4(),
        keychainId: uuidv4(),
        logLevel: this.options.logLevel || "INFO",
      });
    }
    this.log.info("KeychainID=%o", this.keychain.getKeychainId());
  }

  public async stop(): Promise<void> {
    try {
      this.log.info(`Stopping...`);
      await Promise.all([
        this.besu.stop().then(() => this.besu.destroy()),
        this.fabric.stop().then(() => this.fabric.destroy(),
      ]);
      this.log.info(`Stopped OK`);
    } catch (ex) {
      this.log.error(`Stopping crashed: `, ex);
      throw ex;
    }
  }

  public async start(): Promise<void> {
    try {
      this.log.info(`Starting dummy infrastructure...`);
      await this.fabric.start({ omitPull: false });
      await this.besu.start();
      this.log.info(`Started dummy infrastructure OK`);
    } catch (ex) {
      this.log.error(`Starting of dummy infrastructure crashed: `, ex);
      throw ex;
    }
  }

  public async deployContracts(): Promise<ISupplyChainContractDeploymentInfo> {
    try {
      this.log.info(`Deploying example supply chain app smart contracts...`);

      await this.keychain.set(
        BookshelfRepositoryJSON.contractName,
        JSON.stringify(BookshelfRepositoryJSON),
      );
      await this.keychain.set(
        BambooHarvestRepositoryJSON.contractName,
        JSON.stringify(BambooHarvestRepositoryJSON),
      );

      const bambooHarvestRepository = await this.deployBesuContract();
      const bookshelfRepository = await this.deployBesuContract();
      const shipmentRepository = await this.deployFabricContract();

      const out: ISupplyChainContractDeploymentInfo = {
        bambooHarvestRepository,
        bookshelfRepository,
        shipmentRepository,
      };

      this.log.info(`Deployed example supply chain app smart contracts OK`);

      return out;
    } catch (ex) {
      await new Promise((res) => setTimeout(res, 6000000));
      this.log.error(`Deployment of smart contracts crashed: `, ex);
      throw ex;
    }
  }

  public async deployBesuContract(): Promise<IEthContractDeployment> {
    this._besuAccount = await this.besu.createEthTestAccount(2000000);
    const rpcApiHttpHost = await this.besu.getRpcApiHttpHost();
    const rpcApiWsHost = await this.besu.getRpcApiWsHost();

    const pluginRegistry = new PluginRegistry();
    pluginRegistry.add(this.keychain);
    const connector = new PluginLedgerConnectorBesu({
      instanceId: "PluginLedgerConnectorBesu_Contract_Deployment",
      rpcApiHttpHost,
      rpcApiWsHost,
      logLevel: this.options.logLevel,
      pluginRegistry,
    });

    const res = await connector.deployContract({
      contractName: BambooHarvestRepositoryJSON.contractName,
      bytecode: BambooHarvestRepositoryJSON.bytecode,
      contractAbi: BambooHarvestRepositoryJSON.abi,
      constructorArgs: [],
      gas: 1000000,
      web3SigningCredential: {
        ethAccount: this.besuAccount.address,
        secret: this.besuAccount.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      },
      keychainId: this.keychain.getKeychainId(),
    });
    const {
      transactionReceipt: { contractAddress },
    } = res;

    const bambooHarvestRepository: IEthContractDeployment = {
      abi: BambooHarvestRepositoryJSON.abi,
      address: contractAddress as string,
      bytecode: BambooHarvestRepositoryJSON.bytecode,
      contractName: BambooHarvestRepositoryJSON.contractName,
      keychainId: this.keychain.getKeychainId(),
    };

    return bambooHarvestRepository;
  }

  public async deployFabricContract(): Promise<IFabricContractDeployment> {
    const connectionProfile = await this.fabric.getConnectionProfileOrg1();
    const sshConfig = await this.fabric.getSshConfig();
    const discoveryOptions: DiscoveryOptions = {
      enabled: true,
      asLocalhost: true,
    };

    const pluginRegistry = new PluginRegistry();
    pluginRegistry.add(this.keychain);
    const connector = new PluginLedgerConnectorFabric({
      instanceId: "PluginLedgerConnectorFabric_Contract_Deployment",
      dockerBinary: "/usr/local/bin/docker",
      pluginRegistry,
      peerBinary: "peer",
      sshConfig: sshConfig,
      logLevel: this.options.logLevel || "INFO",
      connectionProfile: connectionProfile,
      cliContainerEnv: FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
      discoveryOptions: discoveryOptions,
      eventHandlerOptions: {
        strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
      },
    });

    const res = await connector.deployContractGoSourceV1({
      tlsRootCertFiles:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1.CORE_PEER_TLS_ROOTCERT_FILE,
      targetPeerAddresses: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1.CORE_PEER_ADDRESS,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2.CORE_PEER_ADDRESS,
      ],
      policyDslSource: "OR('Org1MSP.member','Org2MSP.member')",
      channelId: "mychannel",
      chainCodeVersion: "1.0.0",
      constructorArgs: { Args: [] },
      goSource: {
        body: Buffer.from(SHIPMENT_CONTRACT_GO_SOURCE).toString("base64"),
        filename: "shipment.go",
      },
      moduleName: "shipment",
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      pinnedDeps: SHIPMENT_GOLANG_CONTRACT_PINNED_DEPENDENCIES,
    });
    this.log.debug("Supply chain app Fabric contract deployment result:", res);

    const shipmentRepository = {
      chaincodeId: "shipment",
      channelName: "mychannel",
    };
    return shipmentRepository;
  }
}
