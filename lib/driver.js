import { BaseDriver } from 'appium-base-driver';
import { fs } from 'appium-support';
import { launch } from 'node-simctl';
import { extractBundleId } from 'ios-app-utils';
import WebDriverAgent from './webdriveragent';
import log from './logger';
import { simBooted, createSim } from './simulatorManagement.js';
import { killAllSimulators, getSimulator } from 'appium-ios-simulator';
import { retryInterval } from 'asyncbox';

class WebDriverAgentDriver extends BaseDriver {
  constructor (opts = {}, shouldValidateCaps = true) {
    super(opts, shouldValidateCaps);

    // TODO set up desired cap constraints
    //this.desiredCapConstraints = desiredCapConstraints;
    this.wda = null;
    this.sim = null;
    this.jwpProxyActive = false;
    this.proxyReqRes = null;
    this.jwpProxyAvoid = [];
  }

  get driverData () {
    // TODO fill out resource info here
    return {};
  }

  async createSession (caps) {
    try {
      // TODO add validation on caps
      // TODO handle otherSessionData for multiple sessions
      let sessionId;
      [sessionId] = await super.createSession(caps);
      // fail very early if the app doesn't actually exist
      await this.checkAppPresent();
      if (!this.opts.bundleId) {
        this.opts.bundleId = await extractBundleId(this.opts.app);
      }

      // start sim, or use running sim
      log.info('starting simlator (if not booted)');
      // TODO add real device support. (webdriveragent will need a udid not a sim. need to tail device logs instead of sim logs)
      this.sim = await this.startSim();

      this.wda = new WebDriverAgent({
        sim: this.sim,
        platformVersion: this.opts.platformVersion,
        host: this.opts.host,
        agentPath: this.opts.agentPath
      });

      await this.wda.launch(sessionId);

      this.proxyReqRes = this.wda.proxyReqRes.bind(this.wda);
      this.jwpProxyActive = true;

      await this.startSession(this.opts.app, this.opts.bundleId);

      return [sessionId, caps];
    } catch (e) {
      await this.deleteSession();
      throw e;
    }
  }

  async deleteSession () {
    this.jwpProxyActive = false;
    this.proxyReqRes = null;
    await this.wda.quit();
    // TODO: this kills all simulators, so needs to be changed if running multiple sims
    // TODO: add handling of 'reset' desired caps (no-reset, full-reset, etc.)
    await this.sim.shutdown();
    if (!this.caps.udid) {
      await this.sim.delete();
    }
    await super.deleteSession();
  }

  async checkAppPresent () {
    log.debug("Checking whether app is actually present");
    if (!(await fs.exists(this.opts.app))) {
      log.errorAndThrow(`Could not find app at ${this.opts.app}`);
    }
  }

  async startSim () {
    let sim;
    // TODO for now just kill all sims unless specified udid is booted.
    // if booted, use it. if not booted, start it up
    // if no udid, well lets see if we can start one up based on desired caps
    // if we support multiple sims we need to change this
    if (this.opts.udid) {
      sim = await getSimulator(this.opts.udid);
      if (!await simBooted(this.opts.udid)) {
        log.info(`simulator with udid ${this.opts.udid} not booted. Booting up now`);
        await killAllSimulators();
        await sim.run();
      } else {
        log.info(`simulator ${this.opts.udid} already booted`);
      }
      return sim;
    }

    log.info(`simulator udid not provided, using desired caps to create a new sim`);

    // create sim for caps
    await killAllSimulators();
    sim = await createSim(this.caps, this.sessionId);
    log.info(`created simulator ${sim.udid}. Booting it up`);
    await sim.run();
    log.info(`simulator booted`);

    return sim;
  }

  async launchApp () {
    const APP_LAUNCH_TIMEOUT = 20 * 1000;

    await launch(this.sim.udid, this.opts.bundleId);

    let checkStatus = async () => {
      let response = await this.wda.jwproxy.command('/status', 'GET');
      let currentApp = response.currentApp.bundleID;
      if (currentApp !== this.opts.bundleId) {
        throw new Error(`${this.opts.bundleId} not in foreground. ${currentApp} is in foreground`);
      }
    };

    log.info(`waiting for ${this.opts.bundleId} to be in foreground`);
    await retryInterval(APP_LAUNCH_TIMEOUT / 200, 200, checkStatus);
    log.info(`${this.opts.bundleId} is in foreground`);
  }

  async startSession(appPath, bundleId) {
    let desired = {
      desiredCapabilities: {
        app: appPath,
        bundleId: bundleId
      }
    };
    await this.wda.jwproxy.command('/session', 'POST', desired);
  }

}

export { WebDriverAgentDriver };