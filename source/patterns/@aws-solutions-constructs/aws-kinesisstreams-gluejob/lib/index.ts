/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as glue from '@aws-cdk/aws-glue';
import { CfnPolicy, Effect, IRole, Policy, PolicyStatement } from '@aws-cdk/aws-iam';
import { Stream, StreamProps } from '@aws-cdk/aws-kinesis';
import { Bucket } from '@aws-cdk/aws-s3';
import { Aws, Construct } from '@aws-cdk/core';
import * as defaults from '@aws-solutions-constructs/core';

export interface KinesisstreamsToGluejobProps {
  /**
   * Existing instance of Kineses Data Stream. If not set, it will create an instance
   */
  readonly existingStreamObj?: Stream;
  /**
   * User provided props to override the default props for the Kinesis Stream.
   *
   * @default - Default props are used
   */
  readonly kinesisStreamProps?: StreamProps | any;
  /**
   * User provides props to override the default props for Glue ETL Jobs. Providing both this and
   * existingGlueJob will cause an error.
   *
   * This parameter is defined as `any` to not enforce passing the Glue Job role which is a mandatory parameter
   * for CfnJobProps. If a role is not passed, the construct creates one for you and attaches the appropriate
   * role policies
   *
   * @default - None
   */
  readonly glueJobProps?: glue.CfnJobProps | any;
  /**
   * Existing GlueJob configuration. If this property is provided, any properties provided through @glueJobProps is ignored
   */
  readonly existingGlueJob?: glue.CfnJob;
  /**
   * Structure of the records in the Amazon Kinesis Data Streams. An example of such a  definition is as below.
   * Either @table or @fieldSchema is mandatory. If @table is provided then @fieldSchema is ignored
   * 	"FieldSchema": [{
   *  	"name": "id",
   *  	"type": "int",
   *    "comment": "Identifier for the record"
   *  }, {
   *    "name": "name",
   *    "type": "string",
   *    "comment": "The name of the record"
   *  }, {
   *    "name": "type",
   *    "type": "string",
   *    "comment": "The type of the record"
   *  }, {
   *    "name": "numericvalue",
   *    "type": "int",
   *    "comment": "Some value associated with the record"
   *  },
   *
   * @default - None
   */
  readonly fieldSchema?: glue.CfnTable.ColumnProperty [];
  /**
   * Glue Table for this construct, If not provided the construct will create a new Table in the
   * database. This table should define the schema for the records in the Kinesis Data Streams.
   * One of @tableprops or @table or @fieldSchema is mandatory. If @tableprops is provided then
   * @table and @fieldSchema are ignored. If @table is provided, @fieldSchema is ignored
   */
  readonly existingTable?: glue.CfnTable;
  /**
   * The table properties for the construct to create the table. One of @tableprops or @table
   * or @fieldSchema is mandatory. If @tableprops is provided then @table and @fieldSchema
   * are ignored. If @table is provided, @fieldSchema is ignored
   */
  readonly tableProps?: glue.CfnTableProps;
  /**
   * Glue Database for this construct. If not provided the construct will create a new Glue Database.
   * The database is where the schema for the data in Kinesis Data Streams is stored
   */
  readonly existingDatabase?: glue.CfnDatabase;
  /**
   * The props for the Glue database that the construct should use to create. If @database is set
   * then this property is ignored. If none of @database and @databaseprops is provided, the
   * construct will define a GlueDatabase resoruce.
   */
  readonly databaseProps?: glue.CfnDatabaseProps;
  /**
   * The output data stores where the transformed data should be written. Current supported data stores
   * include only S3, other potential stores may be added in the future.
   */
  readonly outputDataStore?: defaults.SinkDataStoreProps;
}

/**
 * @summary = This construct either creates or uses the existing construct provided that can be deployed
 * to perform streaming ETL operations using:
 *    - AWS Glue Database
 *    - AWS Glue Table
 *    - AWS Glue Job
 *    - Amazon Kinesis Data Streams
 *    - Amazon S3 Bucket (output datastore).
 * The construct also configures the required role policies so that AWS Glue Job can read data from
 * the streams, process it, and write to an output store.
 */
export class KinesisstreamsToGluejob extends Construct {
  public readonly kinesisStream: Stream;
  public readonly glueJob: glue.CfnJob;
  public readonly glueJobRole: IRole;
  public readonly database: glue.CfnDatabase;
  public readonly table: glue.CfnTable;
  public readonly outputBucket?: [Bucket, (Bucket | undefined)?];

  /**
   * Constructs a new instance of KinesisstreamsToGluejob.Based on the values set in the @props
   *
   * @param scope
   * @param id
   * @param props
   */
  constructor(scope: Construct, id: string, props: KinesisstreamsToGluejobProps) {
    super(scope, id);
    defaults.CheckProps(props);

    this.kinesisStream = defaults.buildKinesisStream(this, {
      existingStreamObj: props.existingStreamObj,
      kinesisStreamProps: props.kinesisStreamProps,
    });

    this.database = props.existingDatabase !== undefined ? props.existingDatabase : defaults.createGlueDatabase(scope, props.databaseProps);

    if (props.fieldSchema === undefined && props.existingTable === undefined && props.tableProps === undefined) {
      throw Error('Either fieldSchema or table property has to be set, both cannot be optional');
    }

    if (props.existingTable !== undefined) {
      this.table = props.existingTable;
    } else {
      this.table = defaults.createGlueTable(scope, this.database, props.tableProps, props.fieldSchema, 'kinesis', {
        STREAM_NAME: this.kinesisStream.streamName
      });
    }

    [ this.glueJob, this.glueJobRole ] = defaults.buildGlueJob(this, {
      existingCfnJob: props.existingGlueJob,
      glueJobProps: props.glueJobProps,
      table: this.table!,
      database: this.database!,
      outputDataStore: props.outputDataStore!
    });

    this.glueJobRole = this.buildRolePolicy(scope, id, this.database, this.table, this.glueJob, this.glueJobRole);
  }

  /**
   * Updates the AWS Glue Job role to include additional policies required for the ETL job to execute
   *
   * @param scope
   * @param glueDatabase
   * @param glueTable
   * @param glueJob
   * @param role
   */
  private buildRolePolicy(scope: Construct, id: string, glueDatabase: glue.CfnDatabase, glueTable: glue.CfnTable,
    glueJob: glue.CfnJob, role: IRole): IRole {
    const _glueJobPolicy = new Policy(scope, `${id}GlueJobPolicy`, {
      statements: [ new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [ 'glue:GetJob' ],
        resources: [ `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:job/${glueJob.ref}` ]
      }), new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [ 'glue:GetSecurityConfiguration' ],
        resources: [ '*' ] // Security Configurations have no resource ARNs
      }), new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [ 'glue:GetTable' ],
        resources: [ `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${glueDatabase.ref}/${glueTable.ref}`,
          `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:database/${glueDatabase.ref}`,
          `arn:${Aws.PARTITION}:glue:${Aws.REGION}:${Aws.ACCOUNT_ID}:catalog`
        ]
      }), new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [ 'cloudwatch:PutMetricData' ],
        resources: [ '*' ], // Metrics do not have resource ARN and hence added conditions
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": "Glue"
          },
          Bool: {
            "aws:SecureTransport": "true"
          }
        }
      }), new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [ 'kinesis:DescribeStream', 'kinesis:DescribeStreamSummary', 'kinesis:GetRecords',
          'kinesis:GetShardIterator', 'kinesis:ListShards', 'kinesis:SubscribeToShard' ],
        resources: [ this.kinesisStream.streamArn ]
      })]
    });

    (_glueJobPolicy.node.defaultChild as CfnPolicy).cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [{
          id: 'W12',
          reason: 'Glue Security Configuration does not have an ARN, and the policy only allows reading the configuration.\
            CloudWatch metrics also do not have an ARN but adding a namespace condition to the policy to allow it to\
            publish metrics only for AWS Glue'
        }]
      }
    };

    role.attachInlinePolicy(_glueJobPolicy);
    return role;
  }
}