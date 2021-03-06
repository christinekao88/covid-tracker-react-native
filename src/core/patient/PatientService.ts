import { injectable } from 'inversify';

import i18n from '@covid/locale/i18n';
import { Services } from '@covid/provider/services.types';
import { DEFAULT_PROFILE } from '@covid/utils/avatar';
import { isUSCountry, isGBCountry } from '@covid/core/localisation/LocalisationService';
import { getDaysAgo } from '@covid/utils/datetime';
import { PatientInfosRequest } from '@covid/core/user/dto/UserAPIContracts';
import { IConsentService } from '@covid/core/consent/ConsentService';
import { ApiClientBase } from '@covid/core/api/ApiClientBase';
import { handleServiceError } from '@covid/core/api/ApiServiceErrors';
import appConfig from '@covid/appConfig';
import { Profile } from '@covid/components/Collections/ProfileList';
import { PatientStateType, getInitialPatientState } from '@covid/core/patient/PatientState';
import { container } from '@covid/provider/services';
import { PatientData } from '@covid/core/patient/PatientData';

export interface IPatientService {
  myPatientProfile(): Promise<Profile | null>;
  listProfiles(): Promise<Profile[] | null>;
  createPatient(infos: Partial<PatientInfosRequest>): Promise<PatientInfosRequest>;
  updatePatientInfo(patientId: string, infos: Partial<PatientInfosRequest>): Promise<PatientInfosRequest>;
  setUSStudyInviteResponse(patientId: string, response: boolean): void;
  getPatientDataById(patientId: string): Promise<PatientData>;
  getPatientDataByProfile(profile: Profile): Promise<PatientData>;
}

@injectable()
export class PatientService extends ApiClientBase implements IPatientService {
  // Use accessor to get around circularing dependency
  private get consentService(): IConsentService {
    return container.get<IConsentService>(Services.Consent);
  }

  protected client = ApiClientBase.client;

  public async myPatientProfile(): Promise<Profile | null> {
    try {
      const data = (await this.client.get(`/patient_list/`)).data as Profile[];
      return !!data && data.length > 0 ? data[0] : null;
    } catch (error) {
      handleServiceError(error);
    }
    return null;
  }

  public async listProfiles() {
    try {
      const response = await this.client.get<Profile[] | null>(`/patient_list/`);
      return response.data;
    } catch (error) {
      handleServiceError(error);
    }
    return null;
  }

  public async createPatient(infos: Partial<PatientInfosRequest>) {
    infos = {
      ...infos,
      version: this.getPatientVersion(),
    };
    return (await this.client.post<PatientInfosRequest>(`/patients/`, infos)).data;
  }

  public async updatePatientInfo(patientId: string, infos: Partial<PatientInfosRequest>) {
    infos = {
      ...infos,
      version: this.getPatientVersion(),
    };
    return (await this.client.patch<PatientInfosRequest>(`/patients/${patientId}/`, infos)).data;
  }

  private getPatientVersion() {
    return appConfig.patientVersion;
  }

  public async getPatientDataById(patientId: string): Promise<PatientData> {
    let patientState = getInitialPatientState(patientId);
    const patientInfo = await this.getPatientInfo(patientId);

    if (patientInfo) {
      patientState = await this.updatePatientState(patientState, patientInfo);
    }

    return {
      patientId,
      patientState,
      patientInfo,
      profile: patientState.profile,
    } as PatientData;
  }

  public async getPatientDataByProfile(profile: Profile): Promise<PatientData> {
    let patientState = getInitialPatientState(profile.id);
    const patientInfo = await this.getPatientInfo(profile.id);

    if (patientInfo) {
      patientState = await this.updatePatientState(patientState, patientInfo);
    }

    return {
      patientId: profile.id,
      patientState,
      patientInfo,
      profile,
    } as PatientData;
  }

  private async getPatientInfo(patientId: string): Promise<PatientInfosRequest | null> {
    try {
      const patientResponse = await this.client.get<PatientInfosRequest>(`/patients/${patientId}/`);
      return patientResponse.data;
    } catch (error) {
      handleServiceError(error);
    }
    return null;
  }

  private async updatePatientState(
    patientState: PatientStateType,
    patient: PatientInfosRequest
  ): Promise<PatientStateType> {
    // Calculate the flags based on patient info
    const hasRaceEthnicityAnswer = Array.isArray(patient.race) && patient.race.length > 0;
    const isFemale = patient.gender === 0;
    const isSexNotMale = ![null, 1, 2].includes(patient.gender);
    const isGenderNotMale = ![null, 'male', 'pfnts'].includes(patient.gender_identity);
    const isPeriodCapable = isSexNotMale || isGenderNotMale;
    const isHealthWorker =
      ['yes_does_treat', 'yes_does_interact'].includes(patient.healthcare_professional) ||
      patient.is_carer_for_community;
    const hasBloodPressureAnswer = patient.takes_any_blood_pressure_medications != null;
    const hasCompletedPatientDetails =
      // They've done at least one page of the patient flow. That's a start.
      !!patient.profile_attributes_updated_at &&
      // If they've completed the last page, heart disease will either be true or false
      // and not null. (or any nullable field on the last page)
      patient.has_heart_disease != null;

    let patientName = patient.name;
    if (!patientName || (!patient.reported_by_another && patientName === 'Me')) {
      patientName = i18n.t('default-profile-name');
    }

    const profile: Profile = {
      id: patientState.patientId,
      name: patientName,
      avatar_name: patient.avatar_name ?? DEFAULT_PROFILE,
      reported_by_another: patient.reported_by_another,
    };
    const isReportedByAnother = patient.reported_by_another || false;
    const isSameHousehold = patient.same_household_as_reporter || false;

    const hasPeriodAnswer = !isPeriodCapable || !!patient.period_status;
    const hasHormoneTreatmentAnswer =
      !isPeriodCapable ||
      !!patient.ht_none ||
      !!patient.ht_combined_oral_contraceptive_pill ||
      !!patient.ht_progestone_only_pill ||
      !!patient.ht_mirena_or_other_coil ||
      !!patient.ht_depot_injection_or_implant ||
      !!patient.ht_hormone_treatment_therapy ||
      !!patient.ht_oestrogen_hormone_therapy ||
      !!patient.ht_testosterone_hormone_therapy ||
      !!patient.ht_pfnts ||
      !!patient.ht_other;

    const hasVitaminAnswer = !!patient.vs_asked_at;

    // Decide whether patient needs to answer YourStudy questions
    const consent = await this.consentService.getConsentSigned();
    const shouldAskStudy = (isUSCountry() && consent && consent.document === 'US Nurses') || isGBCountry();

    const hasAtopyAnswers = patient.has_hayfever != null;
    const hasDiabetes = patient.has_diabetes;
    const hasDiabetesAnswers = patient.diabetes_type != null;
    const shouldAskExtendedDiabetes = !hasDiabetesAnswers && hasDiabetes;
    const hasHayfever = patient.has_hayfever;
    const shouldShowUSStudyInvite = patient.contact_additional_studies === null;
    const hasBloodGroupAnswer = patient.blood_group != null;
    const isNHSStudy = patient.is_in_uk_nhs_asymptomatic_study;
    const hasSchoolGroup = patient.has_school_group;

    return {
      ...patientState,
      profile,
      isFemale,
      isPeriodCapable,
      isHealthWorker,
      hasRaceEthnicityAnswer,
      hasBloodPressureAnswer,
      hasPeriodAnswer,
      hasHormoneTreatmentAnswer,
      hasVitaminAnswer,
      hasCompletedPatientDetails,
      isReportedByAnother,
      isSameHousehold,
      shouldAskExtendedDiabetes,
      shouldAskStudy,
      hasAtopyAnswers,
      hasDiabetes,
      hasDiabetesAnswers,
      hasHayfever,
      shouldShowUSStudyInvite,
      hasBloodGroupAnswer,
      isNHSStudy,
      hasSchoolGroup,
    };
  }

  public setUSStudyInviteResponse(patientId: string, response: boolean) {
    this.updatePatientInfo(patientId, { contact_additional_studies: response });
  }
}
