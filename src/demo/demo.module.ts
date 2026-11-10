import { Module } from '@nestjs/common';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { DemoController } from './demo.controller';

@Module({ imports: [VehiclesModule], controllers: [DemoController] })
export class DemoModule {}
