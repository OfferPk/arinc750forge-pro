/**
 * ARINC750Forge Pro (v1.0.0) - Core VHF Transceiver & VDL Mode 2 Engine
 * Airborne VHF Communications Transceiver & VDL Mode 2 (ARINC Characteristic 750 & RTCA DO-186B / DO-224C)
 * 
 * Normative References:
 * - ARINC Characteristic 750-4 / 750-5 (Airborne VHF Communications Transceiver)
 * - ICAO Annex 10, Volume III (Communication Systems - Part I Digital Data, Part II Voice)
 * - Commission Implementing Regulation (EU) No 1079/2012 (European 8.33 kHz Spacing Mandate)
 * - RTCA DO-186B / EUROCAE ED-23C (MOPS for Airborne VHF Communications Radio Equipment)
 * - RTCA DO-224C / EUROCAE ED-92B (MOPS for VDL Mode 2 Airborne Equipment - 31.5 kbps D8PSK)
 * - ARINC Specification 429 (Mark 33 Digital Information Transfer System)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARINC750Engine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ARINC429_LABELS = {
    VHF_TUNING: 0o030,       // Label 030 - VHF Comm Frequency Tuning Word (BCD)
    VHF_STATUS: 0o270,       // Label 270 - VHF Comm Discrete Status & Operating Mode
    VHF_FAULT: 0o350         // Label 350 - Maintenance & Fault BITE Word
  };

  const TRANSCEIVER_MODES = {
    VOICE_AM: 'VOICE_AM (25W DSB-AM)',
    VDL_MODE_2: 'VDL_MODE_2 (31.5 kbps D8PSK)',
    STANDBY: 'STANDBY (Receiver Only)'
  };

  // D8PSK Phase Shift Mapping (3 bits per symbol, Gray code mapping)
  const D8PSK_CONSTELLATION = {
    '000': { phaseShiftDeg: 0,   deltaPhaseRad: 0.0 * Math.PI },
    '001': { phaseShiftDeg: 45,  deltaPhaseRad: 0.25 * Math.PI },
    '011': { phaseShiftDeg: 90,  deltaPhaseRad: 0.5 * Math.PI },
    '010': { phaseShiftDeg: 135, deltaPhaseRad: 0.75 * Math.PI },
    '110': { phaseShiftDeg: 180, deltaPhaseRad: 1.0 * Math.PI },
    '111': { phaseShiftDeg: 225, deltaPhaseRad: 1.25 * Math.PI },
    '101': { phaseShiftDeg: 270, deltaPhaseRad: 1.5 * Math.PI },
    '100': { phaseShiftDeg: 315, deltaPhaseRad: 1.75 * Math.PI }
  };

  /**
   * Helper: Calculate ARINC 429 Bit 32 Odd Parity
   */
  function calculateParity(word31Bits) {
    let count = 0;
    for (let i = 0; i < 31; i++) {
      if ((word31Bits >>> i) & 1) {
        count++;
      }
    }
    return (count % 2 === 0) ? 1 : 0;
  }

  /**
   * Helper: Reverse 8-bit octal label to ARINC 429 transmission order
   */
  function reverseLabelBits(octalLabel) {
    let reversed = 0;
    for (let i = 0; i < 8; i++) {
      reversed = (reversed << 1) | ((octalLabel >> i) & 1);
    }
    return reversed;
  }

  /**
   * Helper: Encode a full ARINC 429 32-bit word with Bit 32 Odd Parity
   */
  function encodeARINC429Word(octalLabel, sdi, dataBits, ssm) {
    const revLabel = reverseLabelBits(octalLabel) & 0xFF;
    const sdiField = (sdi & 0x03) << 8;
    const dataField = (dataBits & 0x7FFFF) << 10;
    const ssmField = (ssm & 0x03) << 29;

    let word = revLabel | sdiField | dataField | ssmField;
    const parity = calculateParity(word);
    word |= (parity << 31);
    return word >>> 0;
  }

  /**
   * Helper: Decode an ARINC 429 32-bit word
   */
  function decodeARINC429Word(word32) {
    const parity = (word32 >>> 31) & 1;
    const wordWithoutParity = word32 & 0x7FFFFFFF;
    const expectedParity = calculateParity(wordWithoutParity);
    const parityValid = (parity === expectedParity);

    const ssm = (word32 >>> 29) & 0x03;
    const data = (word32 >>> 10) & 0x7FFFF;
    const sdi = (word32 >>> 8) & 0x03;
    const rawLabel = word32 & 0xFF;

    let octalLabel = 0;
    for (let i = 0; i < 8; i++) {
      octalLabel = (octalLabel << 1) | ((rawLabel >> i) & 1);
    }

    const ssmMeaning = (ssm === 0x03) ? 'Normal Operation' :
                       (ssm === 0x00) ? 'Failure Warning' :
                       (ssm === 0x01) ? 'No Computed Data (NCD)' : 'Functional Test';

    return {
      wordHex: '0x' + word32.toString(16).toUpperCase().padStart(8, '0'),
      octalLabel: '0' + octalLabel.toString(8).padStart(3, '0'),
      sdi,
      data,
      ssm,
      ssmMeaning,
      parityValid
    };
  }

  /**
   * ICAO Annex 10 & EU 1079/2012 Channel Name to Carrier Frequency Resolver
   * Resolves channel names e.g. "118.005", "118.010", "118.025" to RF frequency
   */
  function resolveChannelName(channelNameStr) {
    const channelVal = parseFloat(channelNameStr);
    const mhzBase = Math.floor(channelVal);
    const decimalPart = Math.round((channelVal - mhzBase) * 1000); // 0 to 995

    let spacing = '25_KHZ';
    let rfCarrierMhz = channelVal;

    // Check last digit: if 5 or 0 not ending on 25/50/75/00, it's 8.33 kHz
    const rem25 = decimalPart % 25;
    if (rem25 === 5) {
      // e.g. 005 -> 0.0000 MHz (8.33 kHz)
      // e.g. 030 -> 0.0250 MHz (8.33 kHz)
      // e.g. 055 -> 0.0500 MHz (8.33 kHz)
      spacing = '8.33_KHZ';
      const stepIndex = Math.floor(decimalPart / 25);
      rfCarrierMhz = mhzBase + (stepIndex * 0.025) + 0.00000;
    } else if (rem25 === 10) {
      // e.g. 010 -> +8.333 kHz
      spacing = '8.33_KHZ';
      const stepIndex = Math.floor(decimalPart / 25);
      rfCarrierMhz = mhzBase + (stepIndex * 0.025) + (8.33333 / 1000.0);
    } else if (rem25 === 15) {
      // e.g. 015 -> +16.667 kHz
      spacing = '8.33_KHZ';
      const stepIndex = Math.floor(decimalPart / 25);
      rfCarrierMhz = mhzBase + (stepIndex * 0.025) + (16.66667 / 1000.0);
    } else {
      // Standard 25 kHz legacy channel (e.g. 000, 025, 050, 075)
      spacing = '25_KHZ';
      rfCarrierMhz = channelVal;
    }

    return {
      channelName: channelVal.toFixed(3),
      rfCarrierMhz: parseFloat(rfCarrierMhz.toFixed(5)),
      spacing,
      bandwidthKhz: spacing === '8.33_KHZ' ? 8.33 : 25.0
    };
  }

  /**
   * Helper: Calculate CCITT CRC-16 (0x1021) for VDL Mode 2 AVLC Frames
   */
  function calculateCRC16(dataBytes) {
    let crc = 0xFFFF;
    for (let i = 0; i < dataBytes.length; i++) {
      crc ^= (dataBytes[i] << 8);
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
        } else {
          crc = (crc << 1) & 0xFFFF;
        }
      }
    }
    return crc ^ 0xFFFF;
  }

  /**
   * ARINC 750 Airborne VHF Communications Transceiver LRU Class
   */
  class ARINC750Transceiver {
    constructor(config = {}) {
      this.unitId = config.unitId || 1; // 1 = VHF 1 (Captain Voice), 2 = VHF 2 (First Officer Voice), 3 = VHF 3 (VDL2 Data)
      this.channelName = config.channelName || '118.005'; // Default 8.33 kHz channel
      this.mode = config.mode || (this.unitId === 3 ? TRANSCEIVER_MODES.VDL_MODE_2 : TRANSCEIVER_MODES.VOICE_AM);
      this.rfPowerWatts = 25.0; // 25 Watts nominal (+44 dBm)
      this.squelchThresholdDbm = -100.0;
      this.pttActive = false; // Push-To-Talk active
      this.pttTimerSec = 0;
      this.maxPttTimeoutSec = 35.0; // Anti-stuck-mic protective timer
      this.sidetoneActive = false;
      this.vdl2Active = (this.mode === TRANSCEIVER_MODES.VDL_MODE_2);
      this.signalStrengthDbm = config.signalStrengthDbm || -75.0;

      // VDL Mode 2 Telemetry & Packet Engine
      this.vdl2Stats = {
        symbolRateBaud: 10500,
        bitRateBps: 31500,
        modulation: 'D8PSK',
        avlcFramesTransmitted: 0,
        lastPayload: 'CPDLC CONNECT REQ / ATC LOGON'
      };

      this.updateTuning();
    }

    setChannel(nameStr) {
      this.channelName = nameStr;
      this.updateTuning();
      return this.channelInfo;
    }

    setUnit(unit) {
      if (unit !== 1 && unit !== 2 && unit !== 3) {
        throw new Error('VHF Transceiver Unit must be 1, 2, or 3');
      }
      this.unitId = unit;
      if (this.unitId === 3) {
        this.mode = TRANSCEIVER_MODES.VDL_MODE_2;
        this.vdl2Active = true;
      } else {
        this.mode = TRANSCEIVER_MODES.VOICE_AM;
        this.vdl2Active = false;
      }
      return this.unitId;
    }

    keyPTT(active = true) {
      if (this.mode === TRANSCEIVER_MODES.STANDBY) {
        throw new Error('Cannot key transmitter while in STANDBY mode');
      }
      this.pttActive = Boolean(active);
      this.sidetoneActive = this.pttActive;
      this.pttTimerSec = this.pttActive ? 0.0 : 0.0;
      return {
        pttActive: this.pttActive,
        transmitterKeyed: this.pttActive,
        rfOutputPowerWatts: this.pttActive ? this.rfPowerWatts : 0.0,
        sidetoneActive: this.sidetoneActive
      };
    }

    updateTuning() {
      this.channelInfo = resolveChannelName(this.channelName);
      return this.channelInfo;
    }

    /**
     * Synthesize a VDL Mode 2 D8PSK AVLC Telemetry Packet
     */
    synthesizeVDL2Frame(payloadText = 'WILCO / ALT CLIMB FL370') {
      const payloadBytes = [];
      for (let i = 0; i < payloadText.length; i++) {
        payloadBytes.push(payloadText.charCodeAt(i));
      }

      // Compute AVLC Frame Check Sequence (FCS CRC-16)
      const fcs = calculateCRC16(payloadBytes);
      this.vdl2Stats.avlcFramesTransmitted++;
      this.vdl2Stats.lastPayload = payloadText;

      // Generate D8PSK Constellation Vector
      const symbols = [];
      for (let i = 0; i < payloadBytes.length; i++) {
        const byte = payloadBytes[i];
        // Split into 3-bit triads
        const t1 = ((byte >> 5) & 0x07).toString(2).padStart(3, '0');
        const t2 = ((byte >> 2) & 0x07).toString(2).padStart(3, '0');
        symbols.push(D8PSK_CONSTELLATION[t1]);
        symbols.push(D8PSK_CONSTELLATION[t2]);
      }

      return {
        frameSequence: this.vdl2Stats.avlcFramesTransmitted,
        payload: payloadText,
        crc16Hex: '0x' + fcs.toString(16).toUpperCase().padStart(4, '0'),
        symbolCount: symbols.length,
        baudRate: 10500,
        bitRate: 31500,
        modulation: 'D8PSK (3 bits/symbol)'
      };
    }

    /**
     * Encode ARINC 429 Label 030 (VHF Comm Frequency Tuning Word)
     * Format: BCD channel/frequency serialization
     */
    encodeLabel030() {
      const channelVal = parseFloat(this.channelName);
      const freqInt = Math.round(channelVal * 1000);
      const mhz100 = Math.floor(freqInt / 100000) % 10;
      const mhz10 = Math.floor(freqInt / 10000) % 10;
      const mhz1 = Math.floor(freqInt / 1000) % 10;
      const khz100 = Math.floor(freqInt / 100) % 10;
      const khz10 = Math.floor(freqInt / 10) % 10;
      const khz1 = freqInt % 10;

      // Pack into 16-bit BCD data field
      const bcdVal = (mhz10 << 12) | (mhz1 << 8) | (khz100 << 4) | (khz10);
      const sdi = (this.unitId === 3) ? 3 : (this.unitId === 2 ? 2 : 1);
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.VHF_TUNING, sdi, bcdVal, ssm);
    }

    /**
     * Encode ARINC 429 Label 270 (VHF Comm Equipment Status Word)
     */
    encodeLabel270() {
      let statusBits = 0;
      if (this.pttActive) statusBits |= (1 << 0);           // Transmitter Keyed / PTT
      if (this.sidetoneActive) statusBits |= (1 << 1);      // Sidetone Audio Active
      if (this.channelInfo.spacing === '8.33_KHZ') statusBits |= (1 << 2); // 8.33 kHz mode active
      if (this.vdl2Active) statusBits |= (1 << 3);          // VDL Mode 2 Data Active
      if (this.signalStrengthDbm > this.squelchThresholdDbm) statusBits |= (1 << 4); // Squelch Open (Audio Unmuted)

      const sdi = (this.unitId === 3) ? 3 : (this.unitId === 2 ? 2 : 1);
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.VHF_STATUS, sdi, statusBits, ssm);
    }

    /**
     * Encode ARINC 429 Label 350 (VHF Comm Maintenance / Fault BITE Word)
     */
    encodeLabel350() {
      const faultBits = 0x00; // Normal healthy hardware
      const sdi = (this.unitId === 3) ? 3 : (this.unitId === 2 ? 2 : 1);
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.VHF_FAULT, sdi, faultBits, ssm);
    }

    getTelemetrySnapshot() {
      const l030 = this.encodeLabel030();
      const l270 = this.encodeLabel270();
      const l350 = this.encodeLabel350();

      return {
        timestamp: new Date().toISOString(),
        unitId: `VHF ${this.unitId} (${this.unitId === 1 ? 'Captain Voice' : this.unitId === 2 ? 'First Officer Voice' : 'VDL Mode 2 Data Link'})`,
        channelName: this.channelName,
        rfCarrierMhz: this.channelInfo.rfCarrierMhz,
        channelSpacing: this.channelInfo.spacing,
        channelBandwidthKhz: this.channelInfo.bandwidthKhz,
        operationalMode: this.mode,
        transmitterStatus: {
          pttActive: this.pttActive,
          transmitterKeyed: this.pttActive,
          rfOutputPowerWatts: this.pttActive ? this.rfPowerWatts : 0.0,
          sidetoneActive: this.sidetoneActive,
          maxPttTimeoutSec: this.maxPttTimeoutSec
        },
        receiverStatus: {
          squelchOpen: this.signalStrengthDbm > this.squelchThresholdDbm,
          signalStrengthDbm: this.signalStrengthDbm,
          squelchThresholdDbm: this.squelchThresholdDbm
        },
        vdlMode2: {
          active: this.vdl2Active,
          symbolRateBaud: this.vdl2Stats.symbolRateBaud,
          bitRateBps: this.vdl2Stats.bitRateBps,
          modulation: this.vdl2Stats.modulation,
          avlcFramesTransmitted: this.vdl2Stats.avlcFramesTransmitted,
          lastPayload: this.vdl2Stats.lastPayload
        },
        arinc429Words: {
          label030_Tuning: decodeARINC429Word(l030),
          label270_Status: decodeARINC429Word(l270),
          label350_Maintenance: decodeARINC429Word(l350)
        }
      };
    }
  }

  return {
    ARINC750Transceiver,
    ARINC429_LABELS,
    TRANSCEIVER_MODES,
    D8PSK_CONSTELLATION,
    calculateParity,
    reverseLabelBits,
    encodeARINC429Word,
    decodeARINC429Word,
    resolveChannelName,
    calculateCRC16
  };
}));
