import { Service, PlatformAccessory, CharacteristicEventTypes } from 'homebridge';
import { SwitchBotPlatform } from '../platform';
import { interval, Subject } from 'rxjs';
import { debounceTime, skipWhile, tap } from 'rxjs/operators';
import { DeviceURL } from '../settings';
import { device, deviceStatusResponse } from '../configTypes';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Humidifier {
  private service: Service;
  temperatureservice: Service;

  CurrentRelativeHumidity!: number;
  CurrentTemperature!: number;
  TargetHumidifierDehumidifierState!: number;
  CurrentHumidifierDehumidifierState!: number;
  RelativeHumidityHumidifierThreshold!: number;
  LockPhysicalControls!: number;
  Active!: number;
  WaterLevel!: number;
  deviceStatus!: deviceStatusResponse;
  humidity!: number;

  humidifierUpdateInProgress!: boolean;
  doHumidifierUpdate!: any;

  constructor(
    private readonly platform: SwitchBotPlatform,
    private accessory: PlatformAccessory,
    public device: device,
  ) {
    // default placeholders
    this.CurrentRelativeHumidity = 100;
    this.TargetHumidifierDehumidifierState = this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
    this.CurrentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
    this.Active = this.platform.Characteristic.Active.ACTIVE;
    this.RelativeHumidityHumidifierThreshold = 100;
    this.LockPhysicalControls = this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    this.CurrentTemperature = 100;
    this.WaterLevel = 100;

    // this is subject we use to track when we need to POST changes to the SwitchBot API
    this.doHumidifierUpdate = new Subject();
    this.humidifierUpdateInProgress = false;

    // Retrieve initial values and updateHomekit
    this.refreshStatus();

    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'SwitchBot')
      .setCharacteristic(this.platform.Characteristic.Model, 'SWITCHBOT-HUMIDIFIER-W0801800')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.deviceId);

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    (this.service =
      this.accessory.getService(this.platform.Service.HumidifierDehumidifier) ||
      this.accessory.addService(this.platform.Service.HumidifierDehumidifier)),
    `${this.device.deviceName} ${this.device.deviceType}`;

    // To avoid "Cannot add a Service with the same UUID another Service without also defining a unique 'subtype' property." error,
    // when creating multiple services of the same type, you need to use the following syntax to specify a name and subtype id:
    // this.accessory.getService('NAME') ?? this.accessory.addService(this.platform.Service.Lightbulb, 'NAME', 'USER_DEFINED_SUBTYPE');

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      `${this.device.deviceName} ${this.device.deviceType}`,
    );

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/HumidifierDehumidifier

    // create handlers for required characteristics
    this.service.setCharacteristic(
      this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      this.CurrentHumidifierDehumidifierState,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHumidifierDehumidifierState)
      .setProps({
        validValues: [0, 1],
      })
      .on(CharacteristicEventTypes.SET, this.handleTargetHumidifierDehumidifierStateSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .on(CharacteristicEventTypes.SET, this.handleActiveSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.RelativeHumidityHumidifierThreshold)
      .on(CharacteristicEventTypes.SET, this.handleRelativeHumidityHumidifierThresholdSet.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .on(CharacteristicEventTypes.SET, this.handleLockPhysicalControlsSet.bind(this));

    // create a new Temperature Sensor service
    (this.temperatureservice =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor)),
    `${this.device.deviceName} ${this.device.deviceType} Temperature Sensor`;

    // Retrieve initial values and updateHomekit
    //this.refreshStatus();
    this.updateHomeKitCharacteristics();

    // Start an update interval
    interval(this.platform.config.options!.refreshRate! * 1000)
      .pipe(skipWhile(() => this.humidifierUpdateInProgress))
      .subscribe(() => {
        this.refreshStatus();
      });

    // Watch for Humidifier change events
    // We put in a debounce of 100ms so we don't make duplicate calls
    this.doHumidifierUpdate
      .pipe(
        tap(() => {
          this.humidifierUpdateInProgress = true;
        }),
        debounceTime(100),
      )
      .subscribe(async () => {
        try {
          await this.pushChanges();
        } catch (e) {
          this.platform.log.error(JSON.stringify(e.message));
          this.platform.log.debug('Humidifier %s -', this.accessory.displayName, JSON.stringify(e));
        }
        this.humidifierUpdateInProgress = false;
      });
  }

  /**
   * Parse the device status from the SwitchBot api
   */
  parseStatus() {
    // Current Relative Humidity
    this.CurrentRelativeHumidity = this.deviceStatus.body.humidity;
    this.platform.log.debug(
      'Humidifier %s CurrentRelativeHumidity -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.CurrentRelativeHumidity,
    );
    // Water Level
    if (this.deviceStatus.body) {
      this.WaterLevel = 100; //Will be implimented once available in API.
    } else {
      this.WaterLevel = 0;
    }
    this.platform.log.debug(
      'Humidifier %s WaterLevel -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.WaterLevel,
    );
    // Active
    switch (this.deviceStatus.body.power) {
      case 'on':
        this.Active = this.platform.Characteristic.Active.ACTIVE;
        break;
      default:
        this.Active = this.platform.Characteristic.Active.INACTIVE;
    }
    this.platform.log.debug('Humidifier %s Active -', this.accessory.displayName, 'Device is Currently: ', this.Active);
    // Target Humidifier Dehumidifier State
    switch (this.deviceStatus.body.auto) {
      case true:
        this.TargetHumidifierDehumidifierState = this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER;
        this.CurrentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
        this.RelativeHumidityHumidifierThreshold = this.CurrentRelativeHumidity;
        break;
      default:
        this.TargetHumidifierDehumidifierState = this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
        this.RelativeHumidityHumidifierThreshold = this.deviceStatus.body.nebulizationEfficiency;
        if (this.CurrentRelativeHumidity > this.RelativeHumidityHumidifierThreshold) {
          this.CurrentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
        } else if (this.Active === this.platform.Characteristic.Active.INACTIVE) {
          this.CurrentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE;
        } else {
          this.CurrentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
        }
    }
    this.platform.log.debug(
      'Humidifier %s TargetHumidifierDehumidifierState -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.TargetHumidifierDehumidifierState,
    );
    this.platform.log.debug(
      'Humidifier %s RelativeHumidityHumidifierThreshold -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.RelativeHumidityHumidifierThreshold,
    );
    this.platform.log.debug(
      'Humidifier %s CurrentHumidifierDehumidifierState -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.CurrentHumidifierDehumidifierState,
    );
    // Lock Physical Controls
    if (this.deviceStatus.body.childLock) {
      this.LockPhysicalControls = this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED;
    } else {
      this.LockPhysicalControls = this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    }
    this.platform.log.debug(
      'Humidifier %s LockPhysicalControls -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.LockPhysicalControls,
    );
    // Current Temperature
    this.CurrentTemperature = this.deviceStatus.body.temperature;
    this.platform.log.debug(
      'Humidifier %s CurrentTemperature -',
      this.accessory.displayName,
      'Device is Currently: ',
      this.CurrentTemperature,
    );
  }

  /**
   * Asks the SwitchBot API for the latest device information
   */
  async refreshStatus() {
    try {
      const deviceStatus: deviceStatusResponse = (
        await this.platform.axios.get(`${DeviceURL}/${this.device.deviceId}/status`)
      ).data;
      if (deviceStatus.message === 'success') {
        this.deviceStatus = deviceStatus;
        this.platform.log.debug(
          'Humidifier %s refreshStatus -',
          this.accessory.displayName,
          JSON.stringify(this.deviceStatus),
        );

        this.parseStatus();
        this.updateHomeKitCharacteristics();
      }
    } catch (e) {
      this.platform.log.error(
        `Humidifier - Failed to update status of ${this.device.deviceName}`,
        JSON.stringify(e.message),
        this.platform.log.debug('Humidifier %s -', this.accessory.displayName, JSON.stringify(e)),
      );
    }
  }

  /**
   * Pushes the requested changes to the SwitchBot API
   */
  async pushChanges() {
    if (
      this.TargetHumidifierDehumidifierState ===
        this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER &&
      this.Active === this.platform.Characteristic.Active.ACTIVE
    ) {
      this.platform.log.debug(`Pushing Manual: ${this.RelativeHumidityHumidifierThreshold}!`);
      const payload = {
        commandType: 'command',
        command: 'setMode',
        parameter: `${this.RelativeHumidityHumidifierThreshold}`,
      } as any;

      this.platform.log.info(
        'Sending request for',
        this.accessory.displayName,
        'to SwitchBot API. command:',
        payload.command,
        'parameter:',
        payload.parameter,
        'commandType:',
        payload.commandType,
      );
      this.platform.log.debug('Humidifier %s pushChanges -', this.accessory.displayName, JSON.stringify(payload));

      // Make the API request
      const push = await this.platform.axios.post(`${DeviceURL}/${this.device.deviceId}/commands`, payload);
      this.platform.log.debug('Humidifier %s Changes pushed -', this.accessory.displayName, push.data);
    } else if (
      this.TargetHumidifierDehumidifierState ===
        this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER &&
      this.Active === this.platform.Characteristic.Active.ACTIVE
    ) {
      await this.pushAutoChanges();
    } else {
      await this.pushActiveChanges();
    }
  }

  /**
   * Pushes the requested changes to the SwitchBot API
   */
  async pushAutoChanges() {
    try {
      if (
        this.TargetHumidifierDehumidifierState ===
          this.platform.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER &&
        this.Active === this.platform.Characteristic.Active.ACTIVE
      ) {
        this.platform.log.debug('Pushing Auto!');
        const payload = {
          commandType: 'command',
          command: 'setMode',
          parameter: 'auto',
        } as any;

        this.platform.log.info(
          'Sending request for',
          this.accessory.displayName,
          'to SwitchBot API. command:',
          payload.command,
          'parameter:',
          payload.parameter,
          'commandType:',
          payload.commandType,
        );
        this.platform.log.debug('Humidifier %s pushAutoChanges -', this.accessory.displayName, JSON.stringify(payload));

        // Make the API request
        const pushAuto = await this.platform.axios.post(`${DeviceURL}/${this.device.deviceId}/commands`, payload);
        this.platform.log.debug('Humidifier %s Changes pushed -', this.accessory.displayName, pushAuto.data);
      }
    } catch (e) {
      this.platform.log.error(JSON.stringify(e.message));
      this.platform.log.debug('Humidifier %s -', this.accessory.displayName, JSON.stringify(e));
    }
  }

  /**
   * Pushes the requested changes to the SwitchBot API
   */
  async pushActiveChanges() {
    try {
      if (this.Active === this.platform.Characteristic.Active.INACTIVE) {
        this.platform.log.debug('Pushing Off!');
        const payload = {
          commandType: 'command',
          command: 'turnOff',
          parameter: 'default',
        } as any;

        this.platform.log.info(
          'Sending request for',
          this.accessory.displayName,
          'to SwitchBot API. command:',
          payload.command,
          'parameter:',
          payload.parameter,
          'commandType:',
          payload.commandType,
        );
        this.platform.log.debug(
          'Humidifier %s pushActiveChanges -',
          this.accessory.displayName,
          JSON.stringify(payload),
        );

        // Make the API request
        const pushActive = await this.platform.axios.post(`${DeviceURL}/${this.device.deviceId}/commands`, payload);
        this.platform.log.debug('Humidifier %s Changes pushed -', this.accessory.displayName, pushActive.data);
      }
    } catch (e) {
      this.platform.log.error(JSON.stringify(e.message));
      this.platform.log.debug('Humidifier %s -', this.accessory.displayName, JSON.stringify(e));
    }
  }

  /**
   * Updates the status for each of the HomeKit Characteristics
   */
  updateHomeKitCharacteristics() {
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      this.CurrentRelativeHumidity,
    );
    this.service.updateCharacteristic(this.platform.Characteristic.WaterLevel, this.WaterLevel);
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      this.CurrentHumidifierDehumidifierState,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHumidifierDehumidifierState,
      this.TargetHumidifierDehumidifierState,
    );
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.Active);
    this.service.updateCharacteristic(
      this.platform.Characteristic.RelativeHumidityHumidifierThreshold,
      this.RelativeHumidityHumidifierThreshold,
    );
    this.service.updateCharacteristic(this.platform.Characteristic.LockPhysicalControls, this.LockPhysicalControls);
    this.temperatureservice.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.CurrentTemperature,
    );
  }

  /**
   * Handle requests to set the "Target Humidifier Dehumidifier State" characteristic
   */
  handleTargetHumidifierDehumidifierStateSet(value, callback) {
    this.platform.log.debug(
      'Humidifier %s -',
      this.accessory.displayName,
      `Set TargetHumidifierDehumidifierState: ${value}`,
    );

    this.TargetHumidifierDehumidifierState = value;
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHumidifierDehumidifierState,
      this.TargetHumidifierDehumidifierState,
    );
    this.doHumidifierUpdate.next();
    callback(null);
  }

  /**
   * Handle requests to set the "Active" characteristic
   */
  async handleActiveSet(value, callback) {
    this.platform.log.debug('Humidifier %s -', this.accessory.displayName, `Set Active: ${value}`);
    this.Active = value;
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.Active);
    this.doHumidifierUpdate.next();
    callback(null);
  }

  /**
   * Handle requests to set the "Relative Humidity Humidifier Threshold" characteristic
   */
  handleRelativeHumidityHumidifierThresholdSet(value, callback) {
    this.platform.log.debug(
      'Humidifier %s -',
      this.accessory.displayName,
      `Set RelativeHumidityHumidifierThreshold: ${value}`,
    );

    this.RelativeHumidityHumidifierThreshold = value;
    if (this.Active === this.platform.Characteristic.Active.INACTIVE) {
      this.Active = this.platform.Characteristic.Active.ACTIVE;
      this.CurrentHumidifierDehumidifierState = this.platform.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
    }
    this.service.updateCharacteristic(
      this.platform.Characteristic.RelativeHumidityHumidifierThreshold,
      this.RelativeHumidityHumidifierThreshold,
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHumidifierDehumidifierState,
      this.CurrentHumidifierDehumidifierState,
    );
    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.Active);
    this.doHumidifierUpdate.next();
    callback(null);
  }

  handleLockPhysicalControlsSet(value, callback) {
    this.platform.log.debug('Humidifier %s -', this.accessory.displayName, `Set LockPhysicalControls: ${value}`);
    this.platform.log.warn('Changing the Child Lock from HomeKit is not supported.');

    // change the child lock back to the one the SwitchBot API said the humidifier was set to.
    setTimeout(() => {
      this.service.updateCharacteristic(this.platform.Characteristic.LockPhysicalControls, this.LockPhysicalControls);
    }, 100);

    callback(null);
  }
}
